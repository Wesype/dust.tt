import { collabInternalAuth } from "@front-api/collab/middlewares/collab_internal_auth";
import { collabApp } from "@front-api/collab/middlewares/ctx";

import documents from "./documents";

// Mounted at /internal on the collab server: only front calls these routes.
const app = collabApp();

app.use("*", collabInternalAuth);
app.route("/documents", documents);

export default app;
