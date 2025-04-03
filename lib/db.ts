import { PrismaClient } from "@prisma/client";

// Crear una única instancia de PrismaClient
const db = new PrismaClient();

export default db;
