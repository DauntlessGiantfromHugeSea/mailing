import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";

export default async function Home() {
  const s = await getSession();
  redirect(s ? "/dashboard" : "/login");
}
