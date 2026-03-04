import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getFileContent } from "@tiwi/core";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> }
) {
  const { orgId } = await auth();
  if (!orgId) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const { fileId } = await params;
  
  try {
    const result = await getFileContent({ orgId, fileId });
    if (!result) {
      return new NextResponse("File not found", { status: 404 });
    }

    return new NextResponse(new Uint8Array(result.buffer), {
      headers: {
        "Content-Type": result.contentType,
        "Content-Disposition": `inline; filename="${encodeURIComponent(result.filename)}"`,
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (error) {
    console.error("Failed to fetch file:", error);
    return new NextResponse("Failed to fetch file", { status: 500 });
  }
}
