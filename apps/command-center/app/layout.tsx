import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "anti-ERP — Seu negocio em linguagem natural",
  description: "Um experimento sobre como softwares empresariais podem ser construidos na era dos agentes de IA."
};

export default function RootLayout({
  children
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
