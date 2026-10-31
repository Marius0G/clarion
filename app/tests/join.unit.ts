import { describe, expect, it } from "vitest";
import { parseBCBP } from "../src/join/bcbp";
const pass = (day = "304") =>
  "M1" +
  "PRIVATE/PASSENGER".padEnd(20) +
  "E" +
  "SECRET7" +
  "CRA" +
  "BGY" +
  "W6 " +
  "03412" +
  day +
  "Y" +
  "012A" +
  "00001" +
  "1" +
  "00";
describe("BCBP privacy boundary", () => {
  it("extracts only flight, route and date; drops name, PNR and other fields", () => {
    const result = parseBCBP(pass(), new Date("2026-10-31T12:00:00Z"));
    expect(result).toEqual({
      flight: "W6 3412",
      date: "2026-10-31",
      route: "CRA-BGY",
    });
    expect(Object.keys(result!)).toEqual(["flight", "date", "route"]);
    expect(JSON.stringify(result)).not.toMatch(
      /PRIVATE|PASSENGER|SECRET7|012A/,
    );
  });
  it("rejects malformed and truncated codes", () => {
    for (const raw of [
      "",
      "SECRET7",
      pass("000"),
      pass("367"),
      pass().slice(0, 50),
      pass().replace("CRA", "123"),
    ])
      expect(parseBCBP(raw)).toBeNull();
  });
  it("handles year rollover and leap day-of-year", () => {
    expect(parseBCBP(pass("001"), new Date("2026-12-31Z"))?.date).toBe(
      "2027-01-01",
    );
    expect(parseBCBP(pass("366"), new Date("2024-12-30Z"))?.date).toBe(
      "2024-12-31",
    );
    expect(parseBCBP(pass("366"), new Date("2026-10-31Z"))).toBeNull();
  });
  it("extracts only the first leg", () => {
    expect(
      parseBCBP(
        pass().replace("M1", "M2") + "SECOND LEG",
        new Date("2026-10-31Z"),
      )?.route,
    ).toBe("CRA-BGY");
  });
});
