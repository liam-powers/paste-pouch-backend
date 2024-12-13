import { Application, Context, Router } from "jsr:@oak/oak";
import { customAlphabet } from "jsr:@viki/nanoid";
import postgres from "postgres";
import "jsr:@std/dotenv/load";

const DATABASE_URL = Deno.env.get("DATABASE_URL");

if (!DATABASE_URL || typeof DATABASE_URL != "string") {
  throw new Error("Error getting DATABASE_URL.");
}

const sql = postgres(DATABASE_URL);

const _usersTableRes = await sql`
  CREATE TABLE IF NOT EXISTS users (
    id CHARACTER(16) PRIMARY KEY,
    timestamp TIMESTAMP NOT NULL
  );
`;

const _pastesTableRes = await sql`
  CREATE TABLE IF NOT EXISTS pastes (
    id CHARACTER(16) PRIMARY KEY,
    content TEXT NOT NULL,
    format VARCHAR(64) NOT NULL,
    timestamp TIMESTAMP NOT NULL,
    userid CHARACTER(16) REFERENCES users(id)
  );
`;

function generateId(): string {
  const nanoid = customAlphabet("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ", 16);
  const id = nanoid();
  return id;
}

async function validateUser(id: string): Promise<boolean> {
  let userExistsRes;

  try {
    userExistsRes = await sql`
    SELECT * FROM users
    WHERE id=${id};
  `;
  } catch (_error) {
    return false;
  }

  if (!userExistsRes || userExistsRes.length == 0) {
    return false;
  }

  return true;
}

const router = new Router();

router.get("/create-user", async (ctx) => {
  const id = generateId();
  const timestamp = Date.now();
  try {
    const _insertUserRes = await sql`
      INSERT INTO users (id, timestamp)
      VALUES (${id}, ${timestamp})
    ;`;
  } catch (error) {
    ctx.response.status = 400;
    ctx.response.body =
      "Couldn't create user for some reason, ask devs to check the logs";
    console.error(error);
    return;
  }

  ctx.response.status = 200;
  ctx.response.body = id;
});

router.post("/create-paste", async (ctx) => {
  const body = await ctx.request.body.json();
  let content: string, format: string, userid: string | null;
  const id = generateId();
  const timestamp = Date.now();
  try {
    content = body.content;
    format = body.format;
    userid = body.userid;

    let _insertPasteRes;
    if (!userid) {
      _insertPasteRes = await sql`
        INSERT INTO pastes (id, content, format, timestamp)
        VALUES (${id}, ${content}, ${format}, ${timestamp})
      ;`;
    } else if (!await validateUser(userid)) {
      ctx.response.status = 403;
      ctx.response.body = "You are not authorized to make this paste.";
      return;
    } else {
      // we've validated the userid
      _insertPasteRes = await sql`
      INSERT INTO pastes (id, content, format, userid, timestamp)
      VALUES (${id}, ${content}, ${format}, ${userid}, ${timestamp})
    ;`;
    }
  } catch (error) {
    ctx.response.status = 400;
    ctx.response.body =
      "Couldn't create paste for some reason, ask devs to check the logs";
    console.error(error);
    return;
  }

  ctx.response.status = 200;
  ctx.response.body = id;
});

router.get("/read-paste/:id", async (ctx) => {
  // id is a pasteid
  const id: string | undefined = ctx.params.id;
  if (!id || typeof id != "string") {
    ctx.response.status = 400;
    ctx.response.body = "Must pass an id string";
    return;
  }

  let pasteRes;
  try {
    pasteRes = await sql`
    SELECT * FROM pastes
    WHERE id=${id}
    `;
  } catch (error) {
    ctx.response.status = 403;
    ctx.response.body =
      "Couldn't execute read paste SQL for some reason, ask devs to check the logs";
    console.error(error);
    return;
  }

  if (!pasteRes || pasteRes.length == 0) {
    ctx.response.status = 404;
    ctx.response.body = `No paste with id ${id} found`;
    return;
  }
  ctx.response.status = 200;
  ctx.response.body = pasteRes;
});

router.get("/read-pastes/:id", async (ctx) => {
  // id is a userid
  const id: string | undefined = ctx.params.id;
  if (!id || typeof id != "string") {
    ctx.response.status = 400;
    ctx.response.body = "Must pass an id string";
    return;
  }

  if (!validateUser(id)) {
    ctx.response.status = 403;
    ctx.response.body = "You are not authorized to read this profile";
    return;
  }

  let pasteRes;
  try {
    pasteRes = await sql`
    SELECT * FROM pastes
    WHERE userid=${id}
    `;
  } catch (error) {
    ctx.response.status = 403;
    ctx.response.body =
      "Couldn't execute read paste SQL for some reason, ask devs to check the logs";
    console.error(error);
    return;
  }

  if (!pasteRes || pasteRes.length == 0) {
    ctx.response.status = 404;
    ctx.response.body = `No user with id ${id} found`;
    return;
  }
  ctx.response.status = 200;
  ctx.response.body = pasteRes;
});

interface ClientData {
  count: number;
  lastRequestTime: number;
}

const rateLimitMap = new Map<string, ClientData>();
const RATE_LIMIT_WINDOW = 10 * 1000; // milliseconds
const MAX_REQUESTS = 10; // max requests per rate limit window

async function rateLimiter(ctx: Context, next: () => Promise<unknown>) {
  const clientIp = ctx.request.ip;
  let clientData = rateLimitMap.get(clientIp);
  const timestamp = Date.now();

  if (
    !clientData || timestamp > (clientData.lastRequestTime + RATE_LIMIT_WINDOW)
  ) {
    clientData = {
      count: 1,
      lastRequestTime: timestamp,
    };
    rateLimitMap.set(clientIp, clientData);
  } else if (clientData.count > MAX_REQUESTS) {
    ctx.response.status = 429;
    ctx.response.body = "You're being rate limited. Try again later";
    return;
  } else {
    clientData.count += 1;
    rateLimitMap.set(clientIp, clientData);
  }

  // perform whatever we were going to do before if we reached here
  await next();
}

const app = new Application();
app.use(router.routes());
app.use(router.allowedMethods());
app.use(rateLimiter);

app.listen({ port: 8080 });
