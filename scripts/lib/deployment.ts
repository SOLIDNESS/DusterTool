import fs from "node:fs";
import path from "node:path";
import { parseDeployment, type Deployment, type DeploymentFile } from "../../src/core/deployment";
import { ROOT } from "./env";

/** Nazwa wdrozenia: zmienna DEPLOYMENT albo 'test' (token testowy na mainnecie). */
export const DEPLOYMENT_NAME = process.env.DEPLOYMENT ?? "test";
export const deploymentPath = (name = DEPLOYMENT_NAME) => path.join(ROOT, "deployments", `${name}.json`);

export function readDeploymentFile(name = DEPLOYMENT_NAME): DeploymentFile {
  const file = deploymentPath(name);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { signatures: {} };
}

export function writeDeploymentFile(d: DeploymentFile, name = DEPLOYMENT_NAME): void {
  const file = deploymentPath(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(d, null, 2) + "\n");
}

export function loadDeployment(name = DEPLOYMENT_NAME): Deployment {
  return parseDeployment(readDeploymentFile(name));
}
