import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(__dirname, "../.."),
  serverExternalPackages: [
    "@langchain/core",
    "@langchain/langgraph",
    "@modelcontextprotocol/sdk",
    "fontkit",
    "linebreak",
    "pdfkit",
    "langsmith"
  ],
  transpilePackages: ["@anti-erp/shared"]
};

export default nextConfig;
