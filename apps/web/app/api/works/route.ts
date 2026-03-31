import { NextResponse } from "next/server";
import { works } from "@/data/works";

export async function GET() {
  return NextResponse.json({ works, count: works.length });
}
