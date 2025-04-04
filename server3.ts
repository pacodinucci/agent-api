import "dotenv/config";
import express, { Request, Response } from "express";
import cors from "cors";
import { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { OpenAI } from "openai";
import { Pinecone as PineconeClient } from "@pinecone-database/pinecone";
import { PineconeStore } from "@langchain/pinecone";
import { OpenAIEmbeddings } from "@langchain/openai";
import db from "./lib/db";

type WithContent = { content: string };

const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const tempNames: Record<string, string> = {};

async function interpretUserIntent(
  messages: ChatCompletionMessageParam[],
  context: string,
  systemPrompt: string
): Promise<{ intent: string; message: string }> {
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content: `${systemPrompt}

Sos un asistente virtual especializado en una clínica de belleza. Debés ayudar a los usuarios a responder sus consultas, dar información sobre tratamientos, turnos y precios.

Además, clasificá la intención del mensaje del usuario usando una de estas etiquetas:
- reservar_turno
- consultar_horario
- cancelar_turno
- saludo
- ayuda
- otra

Respondé con un JSON que contenga dos propiedades: "intent" (la etiqueta) y "message" (el texto que le dirías al usuario). No expliques tu decisión.`,
      },
      ...messages,
      {
        role: "user",
        content: `Contexto:
${context}

Teniendo en cuenta el contexto y la conversación anterior, devolvé la respuesta para el usuario en formato JSON como se indicó.`,
      },
    ],
    temperature: 0,
    response_format: { type: "json_object" },
  });

  const content = response.choices[0]?.message?.content;

  if (!content)
    return { intent: "otra", message: "No entendí lo que querés decir." };

  try {
    return JSON.parse(content);
  } catch (err) {
    console.error("❌ Error parseando JSON:", err);
    return { intent: "otra", message: "No entendí lo que querés decir." };
  }
}

app.post("/chat", async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      number,
      messages,
    }: {
      number: string;
      messages: WithContent[];
      name?: string;
      email?: string;
    } = req.body;
    const query = messages?.[messages.length - 1]?.content;

    if (!number || !query) {
      res.status(400).json({ error: "Número o mensaje inválido." });
      return;
    }

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    let chat = await db.chat.findFirst({
      where: { number, createdAt: { gte: startOfDay } },
    });

    if (!chat) {
      chat = await db.chat.create({ data: { number, status: null } });
    }

    await db.message.create({
      data: { number, content: query, role: "user", chatId: chat.id },
    });

    const history = await db.message.findMany({
      where: { chatId: chat.id },
      orderBy: { createdAt: "asc" },
      take: 10,
    });

    const messagesHistory = history.map((m) => ({
      role: m.role as "user" | "assistant" | "system",
      content: m.content,
    }));

    const directions = await db.directions.findMany();
    const systemPrompt = directions[0]?.content || "Sin directiva.";

    const indexName = process.env.PINECONE_INDEXNAME || "";
    const embeddings = new OpenAIEmbeddings({
      model: "text-embedding-ada-002",
    });
    const pinecone = new PineconeClient();
    const pineconeIndex = pinecone.Index(indexName);
    const vectorStore = new PineconeStore(embeddings, { pineconeIndex });

    const embedding = await embeddings.embedQuery(query);
    const results = await vectorStore.similaritySearchVectorWithScore(
      embedding,
      5
    );
    const context = results.map(([doc]) => doc.pageContent).join("\n\n");

    const { intent, message } = await interpretUserIntent(
      [...messagesHistory, { role: "user", content: query }],
      context,
      systemPrompt
    );

    await db.chat.update({ where: { id: chat.id }, data: { status: intent } });

    let extraInfo = {};
    if (intent === "reservar_turno") {
      let customer = await db.customers.findFirst({ where: { phone: number } });

      if (!customer) {
        const lastMsg = messages[messages.length - 1]?.content || "";

        if (!chat.status || chat.status === "reservar_turno") {
          await db.chat.update({
            where: { id: chat.id },
            data: { status: "awaiting_name" },
          });
          const responseText =
            "¡Perfecto! Para avanzar con la reserva necesito que me digas tu nombre completo.";
          await db.message.create({
            data: {
              number,
              content: responseText,
              role: "assistant",
              chatId: chat.id,
            },
          });
          res.json({ intent, message: responseText, customerExists: false });
          return;
        }

        if (chat.status === "awaiting_name") {
          tempNames[number] = lastMsg;
          await db.chat.update({
            where: { id: chat.id },
            data: { status: "awaiting_email" },
          });
          const responseText = `Gracias ${lastMsg}. Ahora decime tu correo electrónico.`;
          await db.message.create({
            data: {
              number,
              content: responseText,
              role: "assistant",
              chatId: chat.id,
            },
          });
          res.json({ intent, message: responseText, customerExists: false });
          return;
        }

        if (chat.status === "awaiting_email") {
          const tempName = tempNames[number];
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          const isValidEmail = emailRegex.test(lastMsg);

          if (!isValidEmail || !tempName) {
            const responseText =
              "El correo electrónico que ingresaste no parece válido. ¿Podés revisarlo y enviarlo nuevamente?";
            await db.message.create({
              data: {
                number,
                content: responseText,
                role: "assistant",
                chatId: chat.id,
              },
            });
            res.json({ intent, message: responseText, customerExists: false });
            return;
          }

          const existingEmail = await db.customers.findFirst({
            where: { email: lastMsg },
          });
          if (existingEmail) {
            const responseText =
              "Este correo ya está registrado. ¿Querés usar otro o continuar con el existente?";
            await db.message.create({
              data: {
                number,
                content: responseText,
                role: "assistant",
                chatId: chat.id,
              },
            });
            res.json({ intent, message: responseText, customerExists: false });
            return;
          }

          customer = await db.customers.create({
            data: { name: tempName, email: lastMsg, phone: number },
          });

          delete tempNames[number];

          const confirmation = `¡Gracias ${tempName}! Te registré con el correo ${lastMsg}. ¿Querés que avancemos con la reserva del turno?`;
          await db.chat.update({
            where: { id: chat.id },
            data: { status: "awaiting_turno_confirmation" },
          });
          await db.message.create({
            data: {
              number,
              content: confirmation,
              role: "assistant",
              chatId: chat.id,
            },
          });
          res.json({ intent, message: confirmation, customerExists: true });
          return;
        }
      } else {
        extraInfo = {
          customerExists: true,
          customer,
          message,
        };
        await db.chat.update({
          where: { id: chat.id },
          data: { status: intent },
        });
      }
    } else {
      await db.chat.update({
        where: { id: chat.id },
        data: { status: intent },
      });
    }

    await db.message.create({
      data: { number, content: message, role: "assistant", chatId: chat.id },
    });

    res.json({ intent, message, ...extraInfo });
  } catch (error) {
    console.error("❌ Error:", error);
    res.status(500).json({ error: "Error procesando la solicitud." });
  }
});

const PORT = process.env.PORT || 3003;
app.listen(PORT, () =>
  console.log(`✅ server3.ts corriendo en http://localhost:${PORT}`)
);
