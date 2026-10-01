import { Workspace } from "@/components/workspace";
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ path?: string[] }>;
  searchParams: Promise<{ mine?: string }>;
}) {
  const { path = [] } = await params;
  const { mine } = await searchParams;
  return <Workspace path={`/${path.join("/")}`} calendarMine={mine === "1"} />;
}
