import { parse as parseYaml } from "yaml";
import type { Deployment } from "@cybercheck/contracts";
import type { Ctx } from "./context.ts";

type Yaml = Record<string, unknown>;

function asList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (v && typeof v === "object") return Object.keys(v as object);
  return v == null ? [] : [String(v)];
}

function envNames(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).split("=")[0]!.trim());
  if (v && typeof v === "object") return Object.keys(v as object);
  return [];
}

export function analyzeDeployment(ctx: Ctx): Deployment {
  const out: Deployment = { containers: [], dockerfiles: [], ci: [], platforms: [], infraResources: [] };
  for (const [path, f] of ctx.src.files) {
    if (/(^|\/)(Dockerfile|Containerfile)(\.[\w-]+)?$/.test(path)) {
      const baseImages = [...f.text.matchAll(/^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/gim)].map((m) => m[1]!);
      const exposes = [...f.text.matchAll(/^\s*EXPOSE\s+(.+)$/gim)].flatMap((m) => m[1]!.trim().split(/\s+/));
      const cmd = f.text.match(/^\s*(?:CMD|ENTRYPOINT)\s+(.+)$/im)?.[1]?.trim().slice(0, 200) ?? null;
      out.dockerfiles.push({ path, baseImages, exposes, cmd });
    } else if (/(^|\/)(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(path)) {
      try {
        const doc = parseYaml(f.text) as Yaml | null;
        const services = (doc?.services ?? {}) as Record<string, Yaml>;
        for (const [name, s] of Object.entries(services)) {
          const lineNo = f.text.split("\n").findIndex((l) => new RegExp(`^\\s{2}${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`).test(l)) + 1 || 1;
          // One entry per definition: the same service name in two compose files is two deployments.
          out.containers.push({
            id: `container:${path}#${name}`,
            status: "observed",
            name,
            file: path,
            image: typeof s?.image === "string" ? s.image : null,
            build: s?.build ? (typeof s.build === "string" ? s.build : String((s.build as Yaml).context ?? ".")) : null,
            ports: asList(s?.ports),
            exposes: asList(s?.expose),
            dependsOn: asList(s?.depends_on),
            envNames: envNames(s?.environment),
            evidence: { path, line: lineNo },
          });
        }
      } catch {
        // invalid YAML
      }
    } else if (/^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(path)) {
      try {
        const doc = parseYaml(f.text) as Yaml | null;
        const jobs = (doc?.jobs ?? {}) as Record<string, Yaml>;
        out.ci.push({
          path,
          provider: "GitHub Actions",
          jobs: Object.entries(jobs).map(([name, j]) => ({
            name,
            steps: ((j?.steps as Yaml[] | undefined) ?? [])
              .map((s) => String(s?.name ?? s?.uses ?? (typeof s?.run === "string" ? s.run.split("\n")[0] : "")))
              .filter(Boolean)
              .slice(0, 12),
          })),
        });
      } catch {
        // invalid
      }
    } else if (/(^|\/)\.gitlab-ci\.yml$/.test(path)) {
      out.ci.push({ path, provider: "GitLab CI", jobs: [...f.text.matchAll(/^([\w-]+):\s*$/gm)].map((m) => ({ name: m[1]!, steps: [] })) });
    } else if (/(^|\/)(vercel\.json|netlify\.toml|fly\.toml|render\.yaml|railway\.(json|toml)|app\.yaml|Procfile|serverless\.ya?ml|amplify\.yml|wrangler\.toml)$/.test(path)) {
      const name = path.split("/").at(-1)!;
      const platform = /vercel/.test(name) ? "Vercel" : /netlify/.test(name) ? "Netlify" : /fly/.test(name) ? "Fly.io" : /render/.test(name) ? "Render" : /railway/.test(name) ? "Railway" : /app\.yaml/.test(name) ? "Google App Engine" : /Procfile/.test(name) ? "Heroku-style Procfile" : /serverless/.test(name) ? "Serverless Framework" : /amplify/.test(name) ? "AWS Amplify" : "Cloudflare Workers";
      out.platforms.push({ name: platform, evidence: { path, line: 1 } });
    } else if (/\.tf$/.test(path)) {
      for (const m of f.text.matchAll(/^\s*resource\s+"([\w-]+)"\s+"([\w-]+)"/gm)) {
        if (out.infraResources.length < 100) out.infraResources.push({ type: m[1]!, name: m[2]!, evidence: { path, line: f.text.slice(0, m.index).split("\n").length } });
      }
    } else if (/\.ya?ml$/.test(path) && /^\s*kind:\s*(Deployment|Service|Ingress|StatefulSet|CronJob)\b/m.test(f.text) && /apiVersion:/.test(f.text)) {
      for (const m of f.text.matchAll(/^\s*kind:\s*(\w+)[\s\S]*?^\s*name:\s*([\w.-]+)/gm)) {
        if (out.infraResources.length < 100) out.infraResources.push({ type: `k8s/${m[1]}`, name: m[2]!, evidence: { path, line: f.text.slice(0, m.index).split("\n").length } });
      }
      if (!out.platforms.some((p) => p.name === "Kubernetes")) out.platforms.push({ name: "Kubernetes", evidence: { path, line: 1 } });
    }
  }
  if (out.infraResources.some((r) => !r.type.startsWith("k8s/")) && !out.platforms.some((p) => p.name === "Terraform")) {
    const first = out.infraResources.find((r) => !r.type.startsWith("k8s/"))!;
    out.platforms.push({ name: "Terraform", evidence: first.evidence });
  }
  void ctx;
  return out;
}
