// Vercel serverless entrypoint — the SINGLE function for the whole app.
// Every route (including "/") is rewritten here by vercel.json. An Express app
// is itself a valid (req, res) handler, which is the shape @vercel/node expects.
import { app } from "../src/server.js";

export default app;
