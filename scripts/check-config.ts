import { validateDeploymentConfig } from "../src/server/config";

// Runs before migrations and before the site or worker starts in the
// deployment Compose file. A failure stops the container before it serves.
const errors = validateDeploymentConfig(process.env);
if (errors.length) {
  console.error("תצורת ההפעלה אינה תקינה:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log(
  `תצורת ההפעלה תקינה (${process.env.DEPLOYMENT_ENVIRONMENT}, גרסה ${process.env.APP_VERSION})`
);
