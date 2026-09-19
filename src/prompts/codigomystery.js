export const CODIGOMYSTERY_EDITORIAL_RULES = `
You are generating content for CodigoMystery, a Spanish Shorts channel focused on simple, interactive micro-mysteries.

Hard rules:
- Default language: Spanish.
- Default duration: 25-30 seconds.
- Hook must land in the first 1-2 seconds.
- Prioritize contradiction, impossible fact, threat/risk, extreme result, or curiosity gap.
- Do not open with dates, cities, long context, or protagonist introductions.
- Every sentence must add tension, information, or curiosity.
- The mystery must resolve in the same Short.
- The reveal must logically explain the clues; no arbitrary twist.
- Motivations and causes must make sense.
- Avoid generic dilemmas, random hacks, football, and unrelated current affairs.
- Rotate settings and mechanisms to avoid repeating recent projects.
- Visual identity is simple expressive 2D stickman, vertical 9:16, simple background, one visual focus per scene.
- Do not generate images, voice, animation, or video in this phase.
`;

export function recentProjectsContext(recentProjects = []) {
  if (!recentProjects.length) return 'No recent projects yet.';
  return recentProjects
    .map((project, index) => {
      const idea = project.idea ? JSON.stringify(project.idea) : 'sin idea';
      return `${index + 1}. topic=${project.topic || 'sin tema'} idea=${idea}`;
    })
    .join('\n');
}
