const app = require("./app");
const port = Number(process.env.PORT || 4330);
app.listen(port, () => console.log(`hotel-management-gauntlet listening on ${port}`));
