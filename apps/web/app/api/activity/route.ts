import { NextResponse } from "next/server";
import { getRecentActivity } from "@/lib/activity";

export async function GET() {
  const events = await getRecentActivity();
  return NextResponse.json({ events, revalidateInSeconds: 60 });
}
