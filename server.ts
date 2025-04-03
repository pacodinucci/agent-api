import "dotenv/config";
import express, { Request, Response } from "express";
import cors from "cors";
import { Pinecone as PineconeClient } from "@pinecone-database/pinecone";
import { PineconeStore } from "@langchain/pinecone";
import { OpenAIEmbeddings } from "@langchain/openai";
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";
import db from "./lib/db";

const app = express();
app.use(cors());
app.use(express.json());

app.post("/chat", async (req: any, res: any) => {
  console.log("ENTRO ACA");
  try {
    console.log("Y ACA");
    const { messages } = req.body as {
      messages: { role: string; content: string }[];
    };

    if (!messages || messages.length === 0) {
      return res.status(400).json({ error: "Messages are required" });
    }

    // Obtener `directions` desde la base de datos
    const allDirections = await db.directions.findMany();
    const directionContent =
      allDirections[0]?.content || "Sin direcciones definidas.";

    // Extraer la última consulta del usuario
    const query = messages[messages.length - 1].content;
    if (!query) {
      return res
        .status(400)
        .json({ error: "Query is required in the last message" });
    }

    // Configurar Pinecone y OpenAI
    const indexName = process.env.PINECONE_INDEXNAME || "";
    const embeddings = new OpenAIEmbeddings({
      model: "text-embedding-ada-002",
    });

    const pinecone = new PineconeClient();
    const pineconeIndex = pinecone.Index(indexName);

    const vectorStore = new PineconeStore(embeddings, {
      pineconeIndex,
      maxConcurrency: 5,
    });

    // Generar embedding para la consulta
    const embedding = await embeddings.embedQuery(query);

    // Buscar los 5 chunks más relevantes en Pinecone
    const results = await vectorStore.similaritySearchVectorWithScore(
      embedding,
      5
    );
    const pageContents = results.map(([document]) => document.pageContent);
    const context = pageContents.join("\n\n");

    // Construir los mensajes con contexto
    const updatedMessages: {
      role: "system" | "user" | "assistant";
      content: string;
    }[] = [
      { role: "system", content: directionContent },
      ...(messages as { role: "user" | "assistant"; content: string }[]),
      { role: "user", content: `Contexto:\n${context}\n\nPregunta: ${query}` },
    ];

    // Generar respuesta con OpenAI en streaming
    const result = streamText({
      model: openai("gpt-4o"),
      messages: updatedMessages,
    });

    const streamResponse = await result.toDataStreamResponse();
    if (!streamResponse.body) {
      return res.status(500).json({ error: "Error al generar la respuesta." });
    }

    streamResponse.body.pipe(res);
    return;
  } catch (error) {
    console.error(
      "Error durante la búsqueda semántica o generación de respuesta:",
      error
    );
    return res.status(500).json({ error: "Error procesando la solicitud" });
  }
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () =>
  console.log(`✅ API REST corriendo en http://localhost:${PORT}`)
);
