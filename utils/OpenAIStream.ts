// EventSource Parser
import {
  createParser,
  ParsedEvent,
  ReconnectInterval,
} from "eventsource-parser";

// String template
import format from "string-template";

export type ChatGPTAgent = "user" | "system";

export interface ChatGPTMessage {
  role: ChatGPTAgent;
  content: string;
  type?: string
}

export interface OpenAIStreamPayload {
  model: string;
  messages: ChatGPTMessage[];
  temperature: number;
  top_p: number;
  frequency_penalty: number;
  presence_penalty: number;
  max_tokens: number;
  stream: boolean;
  n: number;
}

export async function OpenAIStream(payload: OpenAIStreamPayload) {
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
  let sentence = "";
  let sentences = [];
  let message = "";
  let fullMessage = "";
  let totalMessages = 0;
  let lastToken = "";
  let rewrite = false;
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

        // Create message ID index
        let messageId = `msg-00000-${payload.messages.length.toString().padStart(4, '0')}`;

        // Add to sentence
        sentence += `${token}`;
        message += `${token}`;
        fullMessage += `${token}`;

        // Evaluate character in context to sentence
        lastToken = token;

        // Check if sentence
        if(counter > 2 && sentence.length > 3 && (
          token.indexOf(".") >= 0 || token.indexOf("?") >= 0 ||
          token.indexOf("!") >= 0 || token.indexOf(":") >= 0
        )) { // Emit sentence
          // Emit sentences early
          if(totalMessages < 1 && message != "") {
            console.log(` -- [${totalMessages} | ${token.replaceAll("\n", "")}] new sentence:`, sentence.trim());

            // // stream transformed JSON resposne as SSE
            // const payload = { sentence: sentence.trim() };
            //
            // // https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events#event_stream_format
            // controller.enqueue(
            //   encoder.encode(`${JSON.stringify(payload)}\n`)
            // );

            // Determine if need to rewrite
            if((sentences.length > 4 || message.length > 300) && !rewrite) {
              console.log(" --> Requires re-write:");

              // Set rewrite flag
              rewrite = true;

              // Send initial response sentence to UI
              const responsePayload = {
                id: `${messageId}-000`,
                type: "response",
                role: "assistant",
                data: {
                  display: true
                },
                content: sentences[0].trim()
              };

              // https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events#event_stream_format
              controller.enqueue(
                encoder.encode(`${JSON.stringify(responsePayload)}\n`)
              );
            }
          }

          // Add to messages
          sentences.push(sentence.trim());

          // Reset sentence
          sentence = "";
        }

        // Clear message (and at least a few tokens in)
        if(counter > 2 && token.indexOf("\n") >= 0) {
          // Increment messages (only if has data)
          totalMessages += 1;

          // Emit sentences early
          if(totalMessages == 1 && rewrite) {
            // Send initial response sentence to UI
            const responsePayload = {
              id: `${messageId}-000`,
              type: "response",
              action: "update",
              data: {
                query: message.replaceAll("\n", "")
              }
            };

            // Stream response payload to browser
            controller.enqueue(
              encoder.encode(`${JSON.stringify(responsePayload)}\n`)
            );
          } else if(totalMessages >= 1 && message.length > 3 && !rewrite) {
            // Format message
            let formattedMessage = message.replaceAll("\n", "");
            console.log(` -- [${totalMessages}] new message:`, formattedMessage);

            // Extract message data format
            let namedEntity = formattedMessage.match(/\{(.*?)\}/);

            // Determine message type (response or threaded)
            let messageType = (totalMessages == 1 || (totalMessages > 1 && namedEntity)) ? "response" : "thread";

            // Send initial response sentence to UI
            if(messageType == "thread") {
              // Parse entity
              let entityParts = namedEntity[1].split("|");

              // Determine list item type
              let listItemType = "recommendation.style.list-item";
              if(entityParts[1].toLowerCase() == "artist") {
                listItemType = "recommendation.artist.list-item";
              }
              if(entityParts[1].toLowerCase() == "artwork") {
                listItemType = "recommendation.artwork.list-item";
              }

              // Update formatted message
              formattedMessage = formattedMessage.replace(namedEntity[0], entityParts[0]);
            } else {
              // Send as-is
              const responsePayload = {
                id: `${messageId}-${(totalMessages-1).toString().padStart(3, '0')}`,
                type: messageType,
                role: "assistant",
                data: {
                  display: true
                },
                content: formattedMessage
              };

              // Stream response payload to browser
              controller.enqueue(
                encoder.encode(`${JSON.stringify(responsePayload)}\n`)
              );
            }
          }

          // Reset message
          message = "";
          sentences = [];
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
