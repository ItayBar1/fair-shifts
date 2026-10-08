import { verifyEffectiveMainRules } from "../src/domain/repository-rules";
try {
  const get = async (path: string) => {
    const result = await fetch(
      `https://api.github.com/repos/ItayBar1/fair-shifts${path}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          ...(process.env.GITHUB_TOKEN
            ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
            : {}),
        },
        signal: AbortSignal.timeout(10000),
      }
    );
    if (!result.ok) throw new Error("GitHub rules could not be read");
    return result.json();
  };
  const rules = await get("/rules/branches/main");
  if (!Array.isArray(rules)) throw new Error("Invalid effective GitHub rules");
  const ids = [...new Set(rules.map((rule) => rule.ruleset_id))];
  const details = await Promise.all(ids.map((id) => get(`/rulesets/${id}`)));
  console.log(JSON.stringify(verifyEffectiveMainRules(rules, details)));
} catch {
  console.error(
    "Main protection verification failed; effective GitHub rules and bypass settings must match the approved policy"
  );
  process.exitCode = 1;
}
