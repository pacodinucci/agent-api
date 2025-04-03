import db from "./db";
import { OpenAI } from "openai";
import { awaitingReservationConfirmationClassificationPrompt } from "./prompts";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function handleInitialStatusFlow({
  chat,
  fullResponse,
}: {
  chat: { id: string; status: string | null };
  fullResponse: string;
}): Promise<{ handled: boolean; response?: string; newStatus?: string }> {
  // Ver si la respuesta del asistente indica una intención de reserva
  const wantsToReserve = await checkIfStartReservation(fullResponse);

  if (wantsToReserve) {
    await db.chat.update({
      where: { id: chat.id },
      data: { status: "awaiting_reservation_confirmation" },
    });

    return {
      handled: true,
      newStatus: "awaiting_reservation_confirmation",
      response: fullResponse,
      //   response: "¡Perfecto! ¿Te gustaría que te ayude a coordinar un turno? 😊",
    };
  }

  return { handled: false };
}

export async function handleOngoingStatusFlow({
  chat,
  query,
}: {
  chat: { id: string; status: string | null; number: string };
  query: string;
}): Promise<{
  handled: boolean;
  response?: string;
  newStatus?: string | null;
}> {
  switch (chat.status) {
    case "awaiting_reservation_confirmation": {
      const isConfirmation = await checkIfConfirmation(query);

      if (isConfirmation === true) {
        console.log("NUMERO --> ", chat.number);
        const customer = await db.customers.findFirst({
          where: { phone: chat.number },
        });

        if (customer) {
          await db.chat.update({
            where: { id: chat.id },
            data: { status: "awaiting_time_selection" },
          });

          return {
            handled: true,
            newStatus: "awaiting_time_selection",
            response:
              "Genial 😄 ¿Qué día y horario te quedarían cómodos para la consulta?",
          };
        } else {
          await db.chat.update({
            where: { id: chat.id },
            data: { status: "awaiting_user_data" },
          });

          return {
            handled: true,
            newStatus: "awaiting_user_data",
            response:
              "Para poder avanzar necesito tus datos 📝. Por favor decime tu nombre y un correo electrónico.",
          };
        }
      }

      if (isConfirmation === false) {
        await db.chat.update({
          where: { id: chat.id },
          data: { status: null },
        });

        return {
          handled: true,
          newStatus: null,
          response:
            "Entiendo, no hay problema. Si querés reservar más adelante, estoy acá 😊",
        };
      }

      return { handled: false };
    }

    case "awaiting_user_data": {
      const extraction = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [
          {
            role: "system",
            content: `Extraé nombre y correo del siguiente mensaje de WhatsApp. Respondé solo en formato JSON así:
      
            { "name": "Nombre", "email": "correo@example.com" }
            
            Si no podés extraer ambos campos, respondé exactamente: "invalid"`,
          },
          { role: "user", content: query },
        ],
        temperature: 0,
      });

      const content = extraction.choices[0]?.message?.content?.trim();

      if (!content || content === "invalid") {
        return {
          handled: true,
          newStatus: "awaiting_user_data",
          response:
            "No pude identificar tus datos 😅. Por favor decime tu nombre y un correo electrónico válido.",
        };
      }

      // ⚙️ Intentamos parsear el JSON
      try {
        const parsed = JSON.parse(content);
        const { name, email } = parsed;

        // Guardar el nuevo cliente
        await db.customers.create({
          data: {
            name,
            email,
            phone: chat.number,
          },
        });

        // Actualizar status
        await db.chat.update({
          where: { id: chat.id },
          data: { status: "awaiting_time_selection" },
        });

        return {
          handled: true,
          newStatus: "awaiting_time_selection",
          response:
            "¡Gracias! ✅ Ahora sí, ¿qué día y horario te quedarían cómodos para la consulta?",
        };
      } catch (e) {
        console.log("Error en awaiting_user_data: ", e);
        return {
          handled: true,
          newStatus: "awaiting_user_data",
          response:
            "Hubo un problema interpretando tus datos 😕. Podés volver a decirme tu nombre y correo?",
        };
      }
    }

    default:
      return { handled: false };
  }
}

// 🧠 Evalúa si el asistente ofrece agendar un turno
async function checkIfStartReservation(fullResponse: string): Promise<boolean> {
  const result = await openai.chat.completions.create({
    model: "gpt-3.5-turbo",
    messages: [
      awaitingReservationConfirmationClassificationPrompt,
      { role: "user", content: fullResponse },
    ],

    temperature: 0,
  });

  const output = result.choices[0]?.message?.content?.toLowerCase().trim();
  return output === "true";
}

// ✅ Evalúa si el usuario confirmó la propuesta del asistente
async function checkIfConfirmation(query: string): Promise<boolean | null> {
  const result = await openai.chat.completions.create({
    model: "gpt-3.5-turbo",
    messages: [
      {
        role: "system",
        content: `Tu tarea es identificar si el mensaje del usuario indica una aceptación a coordinar un turno. 
          Respondé exclusivamente "true" o "false".
          
          Ejemplos de mensajes que indican SÍ:
          - Sí
          - Dale
          - Me interesa
          - Quiero coordinar
          - Bueno
          - Coordinamos
          - Estoy listo
          - ¿Cuándo puedo ir?
          
          Ejemplos que NO indican aceptación:
          - No por ahora
          - Después lo veo
          - Más adelante
          - Estoy averiguando
          - Solo estoy consultando`,
      },
      { role: "user", content: query },
    ],
    temperature: 0,
  });

  const output = result.choices[0]?.message?.content?.toLowerCase().trim();

  if (output === "true") return true;
  if (output === "false") return false;

  return null;
}
