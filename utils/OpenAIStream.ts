// EventSource Parser
import {
  createParser,
  ParsedEvent,
  ReconnectInterval,
} from "eventsource-parser";

// Wink NLP
// const winkNLP = require( 'wink-nlp' );
// import winkNLP from 'wink-nlp';
// const model = require( 'wink-eng-lite-web-model' );
// const nlp = winkNLP( model );

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

        // Add to sentence
        sentence += `${token}`;
        message += `${token}`;
        fullMessage += `${token}`;

        // Evaluate character in context to sentence
        lastToken = token;

        // Check if sentence
        // if(counter > 2 && sentence.length > 3 && ".?!:".indexOf(token) >= 0) { // Emit sentence
        if(counter > 2 && sentence.length > 3 && (
          token.indexOf(".") >= 0 || token.indexOf("?") >= 0 ||
          token.indexOf("!") >= 0 || token.indexOf(":") >= 0
        )) { // Emit sentence
          // Emit sentences early
          if(totalMessages < 1 && message != "") {
            console.log(` -- [${totalMessages} | ${token.replaceAll("\n", "")}] new sentence:`, sentence.trim());

            // stream transformed JSON resposne as SSE
            const payload = { sentence: sentence.trim() };

            // https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events#event_stream_format
            controller.enqueue(
              encoder.encode(`${JSON.stringify(payload)}\n`)
            );
          }

          // Add to messages
          sentences.push(sentence.trim());

          // Reset sentence
          sentence = "";
        }

        // Clear message (and at least a few tokens in)
        if(counter > 2 && token.indexOf("\n") >= 0) {


          // Do something with message
          // if(message != "") {
          //   console.log("=====");
          //   console.log(message);
          //   console.log("=====");
          //   console.log("\n");
          //
          //   // Increment messages (only if has data)
          //   totalMessages += 1;
          // }

          // console.log("\n=====");
          // console.log(message);
          // console.log("=====\n");

          // Increment messages (only if has data)
          // if(message.length )
          totalMessages += 1;

          // Emit sentences early
          if(totalMessages >= 1 && message.length > 3) {
            console.log(` -- [${totalMessages}] new message:`, message.replaceAll("\n", ""));

            // stream transformed JSON resposne as SSE
            const payload = {
              message: message,
              sentences: sentences.length
            };

            // https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events#event_stream_format
            controller.enqueue(
              encoder.encode(`${JSON.stringify(payload)}\n`)
            );
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
