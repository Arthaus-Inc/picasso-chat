// Utils
import { OpenAIStream, OpenAIStreamPayload } from "../../utils/OpenAIStream";

// Types
// import type { Message, Query } from "../../types/schemas";
import type { ChatGPTAgent, ChatGPTMessage } from "../../utils/OpenAIStream";

if (!process.env.OPENAI_API_KEY) {
  throw new Error("Missing env var from OpenAI");
}

export const config = {
  runtime: "edge",
};

const handler = async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') {
    // Catch CORS
    return new Response("ok", { status: 200 });
  }

  // Extract data
  // const { prompt } = (await req.json()) as {
  //   prompt?: string;
  // };
  const query = await req.json();
  console.log(" - Chat Query -");
  console.log(query);
  console.log("\n");

  /*
   *  [1] Format Inquiry
   */

  // Time function
  const startTime = Date.now();

  // Setup personality
  let messages: ChatGPTMessage[] = [{
    role: "system",
    content: `You are Picasso, a friendly and knowledgable art concierge. You are well versed in all types of art, and your job is to help customers find the best wall art for their home (you should only recommend art that can be printed and framed - nothing like sculptures, for example). You should only talk to them about art, styles of art, artists and home decor. Never mention that you are an AI, and never talk about your limitations. You work for a company called arthaus that sells printed wall art - if asked where one can buy art, respond with "Seeing as I work for arthaus, I'd certainly have to recommend them!" or something similar. Don't tell them that they can search or browse on arthaus (you're integrated into arthaus, so they'll automatically get recommendations from the site when you tell them about styles of art). If specifically asked about non-arthaus places to buy art, do not recommend anywhere else. Pretend you're an employee nervous about losing your job at arthaus if you recommend anywhere else (but in a lighthearted way). Whenever possible suggest specific styles, artworks or artists in list format. Delineate the type of list item (i.e. - {name|type}).`
  }];

  // Construct API message context
  messages.concat(query.messages);

  // Format messages
  let formattedMessages: ChatGPTMessage[] = [];
  for(var i = 0; i < messages.length; i++) {
    if(messages[i].type !== 'products') {
      formattedMessages.push({
        role: messages[i].role,
        content: messages[i].content
      });
    }
  }

  // Create response stream
  const payload: OpenAIStreamPayload = {
    model: "gpt-3.5-turbo",
    messages: formattedMessages,
    temperature: 0.7,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
    max_tokens: 200,
    stream: true,
    n: 1,
  };

  const stream = await OpenAIStream(payload);
  // return stream response (SSE)
  return new Response(
    stream, {
      headers: new Headers({
        // since we don't use browser's EventSource interface, specifying content-type is optional.
        // the eventsource-parser library can handle the stream response as SSE, as long as the data format complies with SSE:
        // https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events#sending_events_from_the_server

        // 'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      })
    }
  );
};

export default handler;
