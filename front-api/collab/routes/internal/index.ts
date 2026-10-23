import { collabInternalAuth } from "@front-api/collab/middlewares/collab_internal_auth";
import { collabApp } from "@front-api/collab/middlewares/ctx";

import documents from "./documents";
import peers from "./peers";

// Mounted at /internal on the collab server: only front and the other collab servers call these
// routes.
const app = collabApp();

app.use("*", collabInternalAuth);
app.route("/documents", documents);
app.route("/peers", peers);

export default app;
