import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import SearchClient from "./ui";

export default async function SearchPage() {
  const { userId, orgId } = await auth();
  if (!userId) redirect("/sign-in");
  if (!orgId) redirect("/onboarding");
  return <SearchClient />;
}

