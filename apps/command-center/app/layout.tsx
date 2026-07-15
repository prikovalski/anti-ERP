import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "anti-ERP Command Center",
  description: "The first MCP-native AI ERP experiment."
};

export default function RootLayout({
  children
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <link rel="stylesheet" href="/globals.css" />
      </head>
      <body>{children}</body>
    </html>
  );
}
