import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isWorkspacePath } from "@/components/workspace-routes";

type Props = { params: Promise<{ path?: string[] }> };
const known = async (params: Props["params"]) => {
  const { path = [] } = await params;
  return isWorkspacePath(`/${path.join("/")}`);
};

// The 404 page's own metadata does not apply when this layout calls notFound.
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return (await known(params)) ? {} : { title: "הדף לא נמצא" };
}

// An unknown address is a 404, not an empty Workspace (#197). The check sits
// above this segment's loading screen: once that screen streams, the status
// is already 200.
export default async function WorkspaceLayout({
  children,
  params,
}: Props & { children: React.ReactNode }) {
  if (!(await known(params))) notFound();
  return children;
}
