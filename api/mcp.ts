import type { VercelRequest, VercelResponse } from "@vercel/node";

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  // Set CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  // Handle OPTIONS preflight
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  try {
    // For now, return a test response to verify routing works
    res.status(200).json({ 
      message: "MCP endpoint reached",
      method: req.method,
      url: req.url,
      note: "FastMCP integration pending - routing is working"
    });
  } catch (error: any) {
    console.error("Error handling request:", error);
    res.status(500).json({ error: "Internal server error", message: error.message });
  }
}
