// Vercel serverless entry point.
// Vercel serves everything in /public as static files directly from its CDN,
// and routes only /api/* here (see vercel.json). This re-exports the Express
// app so all API endpoints work, while static assets update on every deploy.
import app from "../server.js";

export default app;
