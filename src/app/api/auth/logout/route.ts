import { clearSession } from "@/lib/session";
import { seeOther } from "@/lib/http";

export async function POST(): Promise<Response> {
  clearSession();
  return seeOther("/login");
}
