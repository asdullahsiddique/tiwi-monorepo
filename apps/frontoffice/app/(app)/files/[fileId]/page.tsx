import { use } from "react";
import FileViewClient from "../../../files/[fileId]/ui";

export default function FileViewPage(props: {
  params: Promise<{ fileId: string }>;
}) {
  const { fileId } = use(props.params);
  return <FileViewClient fileId={fileId} />;
}
