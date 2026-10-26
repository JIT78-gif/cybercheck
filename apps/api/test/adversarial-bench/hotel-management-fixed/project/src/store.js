// In-memory data for the hotel management API. Seeded with synthetic guests, an administrator and bookings across two
// hotels (tenants). Every credential here is a synthetic test value, never a real secret.
function seed() {
  return {
    users: [
      { id: "g-sun-ava", hotel: "sunrise", email: "ava@sunrise.test", password: "AvaStay2024!", role: "guest", name: "Ava" },
      { id: "g-bay-bo", hotel: "bayview", email: "bo@bayview.test", password: "BoStay2024!", role: "guest", name: "Bo" },
      { id: "a-sun-admin", hotel: "sunrise", email: "manager@sunrise.test", password: "SunriseMgr2024!", role: "admin", name: "Sunrise Manager" },
    ],
    bookings: [
      { id: "bk-1001", hotel: "sunrise", guestId: "g-sun-ava", room: "101", nights: 2, amount: 240, status: "confirmed" },
      { id: "bk-2002", hotel: "bayview", guestId: "g-bay-bo", room: "205", nights: 3, amount: 450, status: "confirmed" },
    ],
    rooms: [
      { id: "101", hotel: "sunrise", kind: "double", price: 120, available: true },
      { id: "205", hotel: "bayview", kind: "suite", price: 150, available: true },
      { id: "307", hotel: "sunrise", kind: "single", price: 90, available: false },
    ],
    settings: { hotel: "sunrise", checkoutHour: 11, currency: "USD" },
    nextBooking: 3003,
  };
}

let state = seed();
module.exports = {
  get: () => state,
  reset: () => { state = seed(); },
};
