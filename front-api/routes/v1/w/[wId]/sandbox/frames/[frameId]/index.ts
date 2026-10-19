import { sandboxApp } from "@front-api/middlewares/ctx";

import databases from "./databases";
import makeLive from "./make-live";

// Mounted at /api/v1/w/:wId/sandbox/frames/:frameId.
const app = sandboxApp();

app.route("/databases", databases);
app.route("/make-live", makeLive);

export default app;
