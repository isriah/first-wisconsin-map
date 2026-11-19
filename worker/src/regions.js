// Region ids and display names.
//
// The source of truth is config/regions.json at the project root. This copy
// exists so the Worker has no build step. If a region is added, renamed or
// removed there, make the same change here (and in the CHAMPION_EMAILS secret).
export const REGIONS = {
  milwaukee: "Milwaukee",
  woww: "WOWW Counties",
  southshore: "South Shore Corridor",
  nel: "Northeast & Lakeshore",
  foxvalley: "Fox Valley",
  cnw: "Central & Northwoods",
  north: "The Great North",
  sevenrivers: "Seven Rivers",
  capital: "Capital Region",
  driftless: "Driftless",
};

// Program ids the form may send, with the names used in emails and Wix labels.
export const PROGRAMS = {
  fll: "FIRST LEGO League",
  ftc: "FIRST Tech Challenge",
  frc: "FIRST Robotics Competition",
  unsure: "Not sure yet",
};
