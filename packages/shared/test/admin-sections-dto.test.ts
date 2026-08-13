import { describe, expect, it } from "vitest";
import { AdminSectionsResponseSchema } from "../src/dto/plugins.js";

describe("AdminSectionsResponseSchema", () => {
  it("accepts a payload with one section containing a page", () => {
    const payload = {
      sections: [{
        pluginId: "travel",
        pages: [{
          pluginId: "travel",
          id: "travel.admin-locations",
          path: "/admin/travel/locations",
          view: {
            kind: "panel",
            title: "Locations",
            children: [{ kind: "text", value: "Manage locations" }],
          },
        }],
      }],
    };
    expect(AdminSectionsResponseSchema.parse(payload)).toEqual(payload);
  });

  it("accepts a payload with multiple sections", () => {
    const payload = {
      sections: [
        {
          pluginId: "travel",
          pages: [{
            pluginId: "travel",
            id: "travel.admin-locations",
            path: "/admin/travel/locations",
            view: { kind: "text", value: "Locations" },
          }],
        },
        {
          pluginId: "crimes",
          pages: [{
            pluginId: "crimes",
            id: "crimes.admin",
            path: "/admin/crimes",
            view: { kind: "text", value: "Crimes" },
          }],
        },
      ],
    };
    expect(AdminSectionsResponseSchema.parse(payload)).toEqual(payload);
  });

  it("accepts an empty sections array", () => {
    expect(AdminSectionsResponseSchema.parse({ sections: [] })).toEqual({ sections: [] });
  });

  it("rejects an extra key on the top-level object (strict)", () => {
    const bad = { sections: [], extra: true };
    expect(() => AdminSectionsResponseSchema.parse(bad)).toThrow();
  });

  it("rejects an extra key on a section object (strict)", () => {
    const bad = {
      sections: [{
        pluginId: "travel",
        pages: [],
        extra: "nope",
      }],
    };
    expect(() => AdminSectionsResponseSchema.parse(bad)).toThrow();
  });

  it("rejects a section with a non-string pluginId", () => {
    const bad = { sections: [{ pluginId: 123, pages: [] }] };
    expect(() => AdminSectionsResponseSchema.parse(bad)).toThrow();
  });

  it("rejects a section with an empty pluginId", () => {
    const bad = { sections: [{ pluginId: "", pages: [] }] };
    expect(() => AdminSectionsResponseSchema.parse(bad)).toThrow();
  });
});
