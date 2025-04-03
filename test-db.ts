import db from "./lib/db";

async function testDB() {
  try {
    const directions = await db.directions.findMany();
    console.log("Direcciones en la base de datos:", directions);
  } catch (error) {
    console.error("Error consultando la base de datos:", error);
  } finally {
    await db.$disconnect();
  }
}

testDB();
