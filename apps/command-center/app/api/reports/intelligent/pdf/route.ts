import { IntelligentReportSchema } from "@anti-erp/shared";
import { NextResponse } from "next/server";
import {
  buildIntelligentReportPdfFilename,
  renderIntelligentReportPdf
} from "@/lib/reports/intelligent-report-pdf";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const report = IntelligentReportSchema.parse(body.report ?? body);
    const pdf = await renderIntelligentReportPdf(report);
    const filename = buildIntelligentReportPdfFilename(report);

    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store"
      }
    });
  } catch (error) {
    console.error("Failed to render intelligent report PDF.", error);
    return NextResponse.json(
      {
        error: "pdf_generation_failed",
        message: "Nao consegui gerar o PDF deste relatorio agora."
      },
      { status: 400 }
    );
  }
}
