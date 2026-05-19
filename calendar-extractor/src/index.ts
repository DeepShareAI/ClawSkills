import { createServer } from "./server";

const PORT = Number(process.env.PORT ?? 8080);
const app = createServer();
app.listen(PORT, () => console.log(`calendar-extractor listening on :${PORT}`));
