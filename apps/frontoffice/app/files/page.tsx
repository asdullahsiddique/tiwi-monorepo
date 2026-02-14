import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import FilesClient from "./ui";

export default async function FilesPage() {
  const { userId, orgId } = await auth();
  if (!userId) redirect("/sign-in");
  if (!orgId) redirect("/onboarding");
  return <FilesClient />;
}

