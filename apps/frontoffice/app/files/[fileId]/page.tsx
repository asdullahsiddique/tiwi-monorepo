import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import FileViewClient from "./ui";

export default async function FileViewPage(props: { params: { fileId: string } }) {
  const { userId, orgId } = await auth();
  if (!userId) redirect("/sign-in");
  if (!orgId) redirect("/onboarding");

  return <FileViewClient fileId={props.params.fileId} />;
}

