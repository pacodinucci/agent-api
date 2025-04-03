import "dotenv/config";
import express, { Request, Response } from "express";
import cors from "cors";
import { Pinecone as PineconeClient } from "@pinecone-database/pinecone";
import { PineconeStore } from "@langchain/pinecone";
import { OpenAIEmbeddings } from "@langchain/openai";
import { OpenAI } from "openai";
import db from "./lib/db";
import {
  handleInitialStatusFlow,
  handleOngoingStatusFlow,
} from "./lib/helpers";
import { ChatCompletionMessageParam } from "openai/resources/chat/completions";

const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post("/chat", async (req: Request, res: Response): Promise<void> => {
  try {
    const { number, messages } = req.body;
    const query = messages?.[messages.length - 1]?.content;

    if (!number || !query) {
      res.status(400).json({ error: "Número o mensaje inválido." });
      return;
    }

    // Buscar o crear chat del día
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    let chat = await db.chat.findFirst({
      where: { number, createdAt: { gte: startOfDay } },
    });

    if (!chat) {
      chat = await db.chat.create({ data: { number, status: null } });
    }

    // Guardar el mensaje del usuario
    await db.message.create({
      data: { number, content: query, role: "user", chatId: chat.id },
    });

    // Si hay estado, manejarlo primero
    if (chat.status !== null) {
      const { handled, response } = await handleOngoingStatusFlow({
        chat,
        query,
      });

      if (handled && response) {
        await db.message.create({
          data: {
            number,
            content: response,
            role: "assistant",
            chatId: chat.id,
          },
        });
        res.json({ response });
        return;
      }
    }

    // Preparar contexto
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

    const updatedMessages: ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      ...messagesHistory,
      { role: "user", content: `Contexto:\n${context}\n\nPregunta: ${query}` },
    ];

    // Obtener respuesta del asistente
    const openaiStream = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: updatedMessages,
      stream: false,
    });

    const fullResponse =
      openaiStream.choices[0]?.message?.content || "No se obtuvo respuesta.";

    // Ver si debe actualizar estado (inicial)
    if (chat.status === null) {
      const { handled, response } = await handleInitialStatusFlow({
        chat,
        fullResponse,
      });

      if (handled && response) {
        await db.message.create({
          data: {
            number,
            content: response,
            role: "assistant",
            chatId: chat.id,
          },
        });
        res.json({ response });
        return;
      }
    }

    // Guardar y responder normalmente
    await db.message.create({
      data: {
        number,
        content: fullResponse,
        role: "assistant",
        chatId: chat.id,
      },
    });

    res.json({ response: fullResponse });
  } catch (error) {
    console.error("❌ Error:", error);
    res.status(500).json({ error: "Error procesando la solicitud." });
  }
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () =>
  console.log(`✅ API REST corriendo en http://localhost:${PORT}`)
);
