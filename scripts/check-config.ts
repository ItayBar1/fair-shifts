import { validateDeploymentConfig } from "../src/server/config";

// Runs before migrations and before the site or worker starts in the
// deployment Compose file. A failure stops the container before it serves.
const errors = validateDeploymentConfig(process.env);
if (!process.env.SERVICE_ROLE) errors.push("SERVICE_ROLE: missing value");
if (errors.length) {
  console.error("The deployment configuration is invalid:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log(
  `The deployment configuration is valid (${process.env.DEPLOYMENT_ENVIRONMENT}, version ${process.env.APP_VERSION})`
);
