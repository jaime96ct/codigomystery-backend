import { requireSupabase } from '../supabase.js';
import {
  createStructuredResponse,
  isOpenAIConfigured,
  openAIModel,
} from '../ai.js';
import {
  CODIGOMYSTERY_EDITORIAL_RULES,
  recentProjectsContext,
} from '../prompts/codigomystery.js';

const ideaSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    topic: { type: 'string' },
    setting: { type: 'string' },
    mechanism: { type: 'string' },
    hook: { type: 'string' },
    premise: { type: 'string' },
    reveal: { type: 'string' },
    why_it_makes_sense: { type: 'string' },
    target_seconds: { type: 'integer', minimum: 20, maximum: 40 },
  },
  required: [
    'title',
    'topic',
    'setting',
    'mechanism',
    'hook',
    'premise',
    'reveal',
    'why_it_makes_sense',
    'target_seconds',
  ],
  additionalProperties: false,
};

const scriptSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    script: { type: 'string' },
    estimated_seconds: { type: 'integer', minimum: 20, maximum: 40 },
    hook: { type: 'string' },
    reveal: { type: 'string' },
  },
  required: ['title', 'script', 'estimated_seconds', 'hook', 'reveal'],
  additionalProperties: false,
};

const qaSchema = {
  type: 'object',
  properties: {
    passed: { type: 'boolean' },
    checks: {
      type: 'object',
      properties: {
        strong_hook: { type: 'boolean' },
        duration_ok: { type: 'boolean' },
        understandable: { type: 'boolean' },
        coherent_explanation: { type: 'boolean' },
        no_plot_holes: { type: 'boolean' },
        no_filler: { type: 'boolean' },
        not_too_repetitive: { type: 'boolean' },
        satisfying_reveal: { type: 'boolean' },
        fits_codigomystery: { type: 'boolean' },
      },
      required: [
        'strong_hook',
        'duration_ok',
        'understandable',
        'coherent_explanation',
        'no_plot_holes',
        'no_filler',
        'not_too_repetitive',
        'satisfying_reveal',
        'fits_codigomystery',
      ],
      additionalProperties: false,
    },
    issues: {
      type: 'array',
      items: { type: 'string' },
    },
    revision_instructions: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: ['passed', 'checks', 'issues', 'revision_instructions'],
  additionalProperties: false,
};

async function createJob(projectId, type, attempt) {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from('jobs')
    .insert({
      project_id: projectId,
      type,
      status: 'RUNNING',
      progress: 0,
      attempt,
      started_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function finishJob(jobId, status, progress = 100, errorMessage = null) {
  const supabase = requireSupabase();
  const { error } = await supabase
    .from('jobs')
    .update({
      status,
      progress,
      error_message: errorMessage,
      finished_at: new Date().toISOString(),
    })
    .eq('id', jobId);

  if (error) throw error;
}

async function updateProject(projectId, patch) {
  const supabase = requireSupabase();
  const { error } = await supabase
    .from('projects')
    .update(patch)
    .eq('project_id', projectId);

  if (error) throw error;
}

async function getRecentProjects(projectId) {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from('projects')
    .select('project_id,topic,idea,created_at')
    .neq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) throw error;
  return data ?? [];
}

async function claimQueuedProject(projectId) {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from('projects')
    .update({
      status: 'GENERATING_IDEA',
      error_message: null,
      generation_model: openAIModel,
    })
    .eq('project_id', projectId)
    .eq('status', 'QUEUED')
    .select()
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function generateIdea(project) {
  const recent = await getRecentProjects(project.project_id);
  const job = await createJob(project.project_id, 'GENERATE_IDEA', 1);

  try {
    const idea = await createStructuredResponse({
      name: 'codigomystery_idea',
      schema: ideaSchema,
      instructions: CODIGOMYSTERY_EDITORIAL_RULES,
      input: `Create one new CodigoMystery micro-mystery idea.
Avoid repeating these recent projects:
${recentProjectsContext(recent)}

Return one coherent mystery with a reveal that fully explains the setup.`,
    });

    await updateProject(project.project_id, {
      idea,
      topic: idea.topic,
      title: idea.title,
      status: 'GENERATING_SCRIPT',
    });
    await finishJob(job.id, 'COMPLETED');
    return idea;
  } catch (error) {
    await finishJob(job.id, 'ERROR', 0, error.message).catch(() => {});
    throw error;
  }
}

async function generateScript(projectId, idea, attempt, qaFeedback = []) {
  const job = await createJob(projectId, 'GENERATE_SCRIPT', attempt);

  try {
    const script = await createStructuredResponse({
      name: 'codigomystery_script',
      schema: scriptSchema,
      instructions: CODIGOMYSTERY_EDITORIAL_RULES,
      input: `Turn this approved idea into a dense spoken script for a Spanish YouTube Short.

IDEA:
${JSON.stringify(idea, null, 2)}

Target 25-30 seconds unless the idea truly needs slightly more.
Do not use headings, timestamps, scene labels, or markdown inside the script.
Resolve the mystery before any optional CTA.
${qaFeedback.length ? `Fix these QA problems from the previous attempt:\n- ${qaFeedback.join('\n- ')}` : ''}`,
    });

    await updateProject(projectId, {
      title: script.title,
      script: script.script,
      status: 'SCRIPT_QA',
      generation_attempts: attempt,
    });
    await finishJob(job.id, 'COMPLETED');
    return script;
  } catch (error) {
    await finishJob(job.id, 'ERROR', 0, error.message).catch(() => {});
    throw error;
  }
}

async function runScriptQa(projectId, idea, script, attempt, recent) {
  const job = await createJob(projectId, 'SCRIPT_QA', attempt);

  try {
    const qa = await createStructuredResponse({
      name: 'codigomystery_script_qa',
      schema: qaSchema,
      instructions: `You are the strict editorial QA gate for CodigoMystery.
A script only passes if the hook is immediate, the logic is coherent, the reveal explains the mystery, there is no filler, and it clearly fits the channel.
Do not be generous. If any important problem exists, passed must be false.`,
      input: `Evaluate this candidate.

EDITORIAL RULES:
${CODIGOMYSTERY_EDITORIAL_RULES}

RECENT PROJECTS:
${recentProjectsContext(recent)}

IDEA:
${JSON.stringify(idea, null, 2)}

SCRIPT:
${JSON.stringify(script, null, 2)}`,
    });

    await updateProject(projectId, {
      script_qa: qa,
      status: qa.passed ? 'READY_FOR_SCENES' : 'GENERATING_SCRIPT',
    });
    await finishJob(job.id, qa.passed ? 'COMPLETED' : 'FAILED');
    return qa;
  } catch (error) {
    await finishJob(job.id, 'ERROR', 0, error.message).catch(() => {});
    throw error;
  }
}

export async function processProject(projectId) {
  if (!isOpenAIConfigured) return { ok: false, skipped: 'openai_not_configured' };

  const project = await claimQueuedProject(projectId);
  if (!project) return { ok: false, skipped: 'not_queued' };

  try {
    const idea = await generateIdea(project);
    const recent = await getRecentProjects(projectId);

    let qaFeedback = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const script = await generateScript(projectId, idea, attempt, qaFeedback);
      const qa = await runScriptQa(projectId, idea, script, attempt, recent);

      if (qa.passed) {
        return { ok: true, status: 'READY_FOR_SCENES', attempt };
      }

      qaFeedback = qa.revision_instructions?.length
        ? qa.revision_instructions
        : qa.issues;
    }

    await updateProject(projectId, {
      status: 'ERROR',
      error_message: 'SCRIPT_QA_FAILED_AFTER_3_ATTEMPTS',
    });
    return { ok: false, status: 'ERROR' };
  } catch (error) {
    await updateProject(projectId, {
      status: 'ERROR',
      error_message: error.message,
    }).catch(() => {});

    throw error;
  }
}

let polling = false;

export async function processNextQueuedProject() {
  if (!isOpenAIConfigured || polling) return;
  polling = true;

  try {
    const supabase = requireSupabase();
    const { data, error } = await supabase
      .from('projects')
      .select('project_id')
      .eq('status', 'QUEUED')
      .order('created_at', { ascending: true })
      .limit(1);

    if (error) throw error;
    const projectId = data?.[0]?.project_id;
    if (projectId) await processProject(projectId);
  } finally {
    polling = false;
  }
}

export function startContentWorker() {
  if (!isOpenAIConfigured) {
    console.log('[content-worker] OPENAI_API_KEY not configured; worker disabled');
    return;
  }

  console.log(`[content-worker] enabled with model ${openAIModel}`);
  void processNextQueuedProject().catch((error) => {
    console.error('[content-worker] initial run failed:', error.message);
  });

  setInterval(() => {
    void processNextQueuedProject().catch((error) => {
      console.error('[content-worker] poll failed:', error.message);
    });
  }, 10000);
}
