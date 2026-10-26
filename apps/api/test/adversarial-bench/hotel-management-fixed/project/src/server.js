const app = require("./app");
const port = Number(process.env.PORT || 4331);
app.listen(port, () => console.log(`hotel-management-fixed listening on ${port}`));
