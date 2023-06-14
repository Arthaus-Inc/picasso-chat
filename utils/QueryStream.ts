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

export interface QueryStreamPayload {
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

// Feature function - is list
function isListItem(_string: string): boolean {
  return /^\d|-/.test( _string);
}

export async function QueryStream(payload: QueryStreamPayload) {
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
  let sentences: string[] = [];
  let message = "";
  let fullMessage = "";
  let context = "";
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

              // Determine if there are any questions in the response
              let questionPayload = null;
              for (var i = 1; i < sentences.length; i++) {
                // Check sentence
                if(sentences[i].indexOf("?") >= 0 || sentences[i].indexOf("!") >= 0) {
                  // Increment message ID
                  //messageId = `msg-00000-${(payload.messages.length + 1).toString().padStart(4, '0')}`;

                  // Set question payload
                  questionPayload = {
                    id: `${messageId}-001`,
                    type: "response",
                    role: "assistant",
                    data: {
                      display: false
                    },
                    content: sentences[i].trim()
                  };

                  // Finish
                  break;
                }
              }

              // Add follow-up
              if(!questionPayload) {
                // Increment message ID
                //messageId = `msg-00000-${(payload.messages.length + 1).toString().padStart(4, '0')}`;

                // Set question payload
                questionPayload = {
                  id: `${messageId}-001`,
                  type: "response",
                  role: "assistant",
                  data: {
                    display: false,
                    topics: [
                      {
                        id: -2,
                        query: "Yes, please recommend specific artworks.",
                        topic: "suggest artworks",
                        selected: false
                      },
                      {
                        id: -1,
                        query: "Can you show me some relevant artists?",
                        topic: "suggest artists",
                        selected: false
                      }
                    ]
                  },
                  content: "Would you like me to make some specific recommendations from our independent artist community?"
                };
              }

              // Send resposne and question
              controller.enqueue(
                encoder.encode(`${JSON.stringify([responsePayload, questionPayload])}||\n`)
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

          // Set context
          context = (context != "" && sentences.length > 0) ? sentences[0].trim() : "";

          // Emit sentences early
          if(totalMessages == 1 && rewrite) {
            // Send initial response sentence to UI
            // const responsePayload = {
            //   id: `${messageId}-000`,
            //   type: "response",
            //   action: "update",
            //   data: {
            //     query: message.replaceAll("\n", "")
            //   }
            // };
            //
            // // Stream response payload to browser
            // controller.enqueue(
            //   encoder.encode(`${JSON.stringify([responsePayload])}\n`)
            // );
          } else if(totalMessages >= 1 && message.length > 3 && !rewrite) {
            // Format message
            let formattedMessage = message.replaceAll("\n", "");
            console.log(` -- [${totalMessages}] new message:`, formattedMessage);

            // Extract message data format
            let namedEntity = formattedMessage.match(/\{(.*?)\}/);
            console.log(" ---> Named Entity: ", namedEntity);

            // Determine message type (response or threaded)
            let messageType = (isListItem(formattedMessage) || (totalMessages > 1 && namedEntity)) ? "thread" : "response";
            console.log((totalMessages > 1 && namedEntity));
            console.log("Is List Item: ", isListItem(formattedMessage));
            console.log("Message Type: ", messageType);

            // Send initial response sentence to UI
            if(messageType == "thread") {
              // Parse entity
              let entityParts = (namedEntity && namedEntity.length > 1) ? namedEntity[1].split("|") : null;
              if(namedEntity && !entityParts) {
                // in case no split
                entityParts = [namedEntity[1]];
              }


              // Clean message
              if(namedEntity && namedEntity.length > 0 && entityParts && entityParts.length > 0) {
                  formattedMessage = formattedMessage.replace(namedEntity[0], entityParts[0]);
              }

              // Format query
              let query = formattedMessage;

              // Determine list item type
              let listItemType = "recommendation.style.list-item";

              // Clean query (numbers)
              if(query.charAt(1) == '.') {
                query = query.slice(3);
              }

              // [1] Check for Artist
              if(entityParts && entityParts.length > 1 && entityParts[1].toLowerCase() == "artist") {
                listItemType = "recommendation.artist.list-item";

                // Clean query ('#. ___: ')
                let colonPos = query.indexOf(": ");
                if(query.charAt(1) == '.' && colonPos > 0) {
                  query = query.slice(colonPos + 2);
                }
              }

              // [2] Check for Artwork
              if(entityParts && entityParts && entityParts.length > 1 && entityParts[1].toLowerCase() == "artwork") {
                listItemType = "recommendation.artwork.list-item";

                // Clean query (' by ___ - ')
                let hyphenPos = query.indexOf("- ");
                if(hyphenPos < 0) {
                  hyphenPos = query.indexOf(": ");
                }
                let byPos = query.indexOf(" by ");
                if(hyphenPos > 0 && byPos > 0 && byPos < hyphenPos) {
                  query = query.slice(hyphenPos + 3);
                }
              }

              // Fail-safe - add "disclaimer"
              if(listItemType == "recommendation.style.list-item") {
                // Add to message
                formattedMessage += " Here are a pieces with similar style from our community:"
              }

              // Format response
              const responsePayload = {
                id: `${messageId}-${(totalMessages-1).toString().padStart(3, '0')}`,
                type: messageType,
                role: "assistant",
                data: {
                  display: false,
                  intent: listItemType,
                  query: query,
                  context: context,
                  target: `${messageId}-${(totalMessages-1).toString().padStart(3, '0')}-a`
                },
                content: formattedMessage
              };

              // Create products placeholder
              const productsPayload = {
                id: `${messageId}-${(totalMessages-1).toString().padStart(3, '0')}-a`,
                type: "products",
                role: "assistant",
                data: {
                  display: false
                },
                content: ""
              };

              // Stream response payload to browser
              controller.enqueue(
                encoder.encode(`${JSON.stringify([responsePayload, productsPayload])}||\n`)
              );
            } else {
              // Send as-is
              const responsePayload = {
                id: `${messageId}-${(totalMessages-1).toString().padStart(3, '0')}`,
                type: messageType,
                role: "assistant",
                data: {
                  display: false
                },
                content: formattedMessage
              };

              // Stream response payload to browser
              controller.enqueue(
                encoder.encode(`${JSON.stringify([responsePayload])}||\n`)
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
