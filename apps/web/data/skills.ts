export type SkillGroup = {
  title: string;
  items: string[];
};

export const skillGroups: SkillGroup[] = [
  {
    title: "XR / MR Dev",
    items: ["Unity", "XR Interaction Toolkit", "OpenXR", "VisionOS", "Quest SDK", "VIVE Wave"]
  },
  {
    title: "Prototyping",
    items: ["Fusion 360", "Shapr3D", "3Dプリント", "pcbway", "ESP32", "SwiftUI"]
  },
  {
    title: "Backend & Ops",
    items: ["TypeScript", "Next.js", "Prisma", "BullMQ", "PostgreSQL", "Redis", "Docker"]
  },
  {
    title: "Leadership",
    items: ["Team Building", "Tech Direction", "STYLY CTO", "Remote Ops", "Product Strategy"]
  }
];
