// EventSource Parser
import {
  createParser,
  ParsedEvent,
  ReconnectInterval,
} from "eventsource-parser";

export type ChatGPTAgent = "user" | "system";

export interface ChatGPTMessage {
  role: ChatGPTAgent;
  content: string;
  type?: string
}

export interface TopicsStreamPayload {
  model: string;
  messages: ChatGPTMessage[];
  temperature: number;
  top_p: number;
  frequency_penalty: number;
  presence_penalty: number;
  max_tokens: number;
  stream: boolean;
  // n: number;
}

export async function TopicsStream(payload: TopicsStreamPayload) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ""}`,
    },
    method: "POST",
    body: JSON.stringify(payload),
  });

  const readableStream = new ReadableStream({
    async start(controller) {
      // callback
      const onParse = (event: ParsedEvent | ReconnectInterval) => {
        if (event.type === "event") {
          const data = event.data;
          controller.enqueue(encoder.encode(data));
        }
      }

      // optimistic error handling
      if (res.status !== 200) {
        const data = {
          status: res.status,
          statusText: res.statusText,
          body: await res.text(),
        }
        console.log(`Error: recieved non-200 status code, ${JSON.stringify(data)}`);
        controller.close();
        return
      }

      // stream response (SSE) from OpenAI may be fragmented into multiple chunks
      // this ensures we properly read chunks and invoke an event for each SSE event stream
      const parser = createParser(onParse);

      // https://web.dev/streams/#asynchronous-iteration
      for await (const chunk of res.body as any) {
        parser.feed(decoder.decode(chunk));
      }
    },
  });

  let counter = 0;
  let message = "";
  let totalMessages = 0;
  let lastToken = "";
  const transformStream = new TransformStream({
    async transform(chunk, controller) {
      const data = decoder.decode(chunk);

      // https://beta.openai.com/docs/api-reference/completions/create#completions/create-stream
      if (data === "[DONE]") {
        controller.terminate();
        return;
      }

      try {
        // Parse streamed payload
        const json = JSON.parse(data);
        const token = json.choices[0].delta?.content || "";

        // Prefix character
        if (counter < 1 && (token.match(/\n/) || []).length) {
          // this is a prefix character (i.e., "\n\n"), do nothing
          return;
        }

        // Add to message
        message += `${token}`;

        // Clear message (and at least a few tokens in)
        if(counter > 2 && token.indexOf("\n") >= 0) {
          // Increment messages (only if has data)
          totalMessages += 1;

          // Emit topics
          if(totalMessages >= 1 && message.length > 3) {
            // Format message
            let formattedMessage = message.replaceAll("\n", "");
            console.log(` -- [${totalMessages}] new topic:`, formattedMessage);

            // Parse suggested dialog topic
            let [ query, topic ] = formattedMessage.slice(3).split(" | ");

            // Create topic message payload
            const topicPayload = {
              id: (totalMessages - 1),
              query: query,
              topic: topic.toLowerCase(),
              selected: false
            }

            // Send to browser
            controller.enqueue(
              encoder.encode(`${JSON.stringify([topicPayload])}||\n`)
            );
          }

          // Reset message
          message = "";
        }

        counter++;
      } catch (e) {
        console.log(e);

        // maybe parse error
        controller.error(e);
      }
    }
  });

  return readableStream.pipeThrough(transformStream);
}
