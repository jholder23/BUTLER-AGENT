import 'dotenv/config';
import { readdir, readFile, mkdir, writeFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import { program } from 'commander';
import inquirer from 'inquirer';
import { exec as cpExec } from 'child_process';
import { promisify } from 'util';
import fetch from 'node-fetch';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HARDCODED_OPENAI_API_KEY = '';
const exec = promisify(cpExec);

function parseUrls(input) {
  if (!input) return [];
  return String(input)
    .split(/[\s,]+/g)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => /^https?:\/\//i.test(s));
}

function normalizeQuestionToInquirer(q) {
  const id = q?.id || q?.name || 'answer';
  const prompt = q?.prompt || q?.message || 'Answer:';
  const kind = q?.type || 'input';
  if (kind === 'select' || kind === 'list') {
    return {
      type: 'list',
      name: id,
      message: prompt,
      choices: Array.isArray(q?.options)
        ? q.options.map((o) => (typeof o === 'string' ? o : o?.label ?? o?.value)).filter(Boolean)
        : [],
    };
  }
  if (kind === 'confirm') {
    return {
      type: 'confirm',
      name: id,
      message: prompt,
      default: Boolean(q?.default ?? false),
    };
  }
  if (kind === 'password' || q?.secret) {
    return {
      type: 'password',
      name: id,
      message: prompt,
      mask: '*',
    };
  }
  return { type: 'input', name: id, message: prompt, default: q?.default ?? '' };
}

async function collectFiles(rootDir, { maxFiles = 40, maxBytesPerFile = 8000 } = {}) {
  const results = [];
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= maxFiles) return;
      const full = path.join(dir, entry.name);
      const rel = path.relative(rootDir, full);
      if (rel.startsWith('.git') || rel.startsWith('node_modules') || rel.startsWith('dist') || rel.startsWith('build')) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        try {
          const content = await readFile(full, 'utf8');
          results.push({
            path: rel.replace(/\\/g, '/'),
            snippet: content.slice(0, maxBytesPerFile),
          });
        } catch {
          // ignore binary or unreadable files
        }
      }
    }
  }
  await walk(rootDir);
  return results;
}

async function downloadFile(rootDir, url, relPath) {
  const targetPath = path.join(rootDir, relPath);
  const dir = path.dirname(targetPath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Download failed (${res.status}) for ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(targetPath, buf);
}

async function runShell(command, cwd) {
  try {
    const { stdout, stderr } = await exec(command, { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
    return { ok: true, stdout: stdout || '', stderr: stderr || '' };
  } catch (err) {
    const stdout = err?.stdout || '';
    const stderr = err?.stderr || '';
    const message = err?.message || String(err);
    return { ok: false, stdout, stderr, message };
  }
}

async function applyActions(rootDir, actions) {
  const summary = { writtenFiles: [], downloadedFiles: [], commands: [] };
  for (const action of actions || []) {
    if (!action || !action.type) continue;
    if (action.type === 'write_file') {
      if (!action.path || typeof action.content !== 'string') continue;
      const targetPath = path.join(rootDir, action.path);
      const dir = path.dirname(targetPath);
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }
      await writeFile(targetPath, action.content, 'utf8');
      summary.writtenFiles.push(action.path);
      // eslint-disable-next-line no-console
      console.log(`Wrote file: ${action.path}`);
    } else if (action.type === 'download_file') {
      if (!action.url || !action.path) continue;
      await downloadFile(rootDir, String(action.url), String(action.path));
      summary.downloadedFiles.push(String(action.path));
      // eslint-disable-next-line no-console
      console.log(`Downloaded: ${action.url} -> ${action.path}`);
    } else if (action.type === 'run_command') {
      if (!action.command) continue;
      const cwd = action.cwd ? path.resolve(rootDir, String(action.cwd)) : rootDir;
      summary.commands.push({ command: String(action.command), cwd, ok: true });
      // eslint-disable-next-line no-console
      console.log(`Running: ${action.command} (cwd: ${cwd})`);
      const result = await runShell(String(action.command), cwd);
      if (!result.ok) {
        summary.commands[summary.commands.length - 1].ok = false;
        summary.commands[summary.commands.length - 1].error = result.message;
        summary.commands[summary.commands.length - 1].stdout = result.stdout;
        summary.commands[summary.commands.length - 1].stderr = result.stderr;
        throw new Error(
          `Command failed: ${action.command}\n\n${result.message}\n\nSTDOUT:\n${result.stdout}\n\nSTDERR:\n${result.stderr}`,
        );
      }
    }
  }
  return summary;
}

async function callOpenAI({ apiKey, systemPrompt, payload }) {
  const openai = new OpenAI({ apiKey });
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify(payload, null, 2) },
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
  });
  const raw = completion.choices[0]?.message?.content || '{}';
  return raw;
}

async function runModelDrivenSession({ effectiveRoot, apiKey, initialInstruction, isNewProject, referenceUrls }) {
  const systemPrompt = `
You are a careful coding assistant that edits developer projects.
You are talking to the USER through a thin CLI connector.

You MUST respond ONLY with JSON and choose ONE of two modes:

Mode A (ask questions):
{
  "mode": "questions",
  "questions": [
    { "id": "hf_token", "type": "password", "prompt": "Paste your Hugging Face token (optional):", "secret": true },
    { "id": "device", "type": "select", "prompt": "Run on GPU or CPU?", "options": ["gpu", "cpu"] }
  ]
}

Mode B (apply changes):
{
  "mode": "actions",
  "summary": "1-3 sentences describing what you did",
  "suggested_urls": ["https://..."],
  "next_steps": ["..."],
  "actions": [
    { "type": "write_file", "path": "relative/path", "content": "full file" },
    { "type": "download_file", "url": "https://...", "path": "relative/path.bin" },
    { "type": "run_command", "command": "npm install", "cwd": "." }
  ]
}

Rules:
- Output valid JSON only.
- If you need info (tokens, OS, GPU, model choice), return mode=questions.
- If is_new_project=true and user asked for a complete setup, do everything needed in one pass (files + install commands).
- If a command fails, the connector will retry and show you the error for repair.
`;

  let instruction = initialInstruction;
  const collectedAnswers = {};

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const files = await collectFiles(effectiveRoot);
    const raw = await callOpenAI({
      apiKey,
      systemPrompt,
      payload: {
        instruction,
        project_root: effectiveRoot,
        is_new_project: Boolean(isNewProject),
        reference_urls: referenceUrls || [],
        answers: collectedAnswers,
        sample_files: files,
      },
    });

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('Failed to parse model response as JSON:', e.message);
      // eslint-disable-next-line no-console
      console.error('Raw response:', raw);
      throw new Error('Model returned invalid JSON.');
    }

    if (parsed?.mode === 'questions' && Array.isArray(parsed.questions) && parsed.questions.length) {
      const qs = parsed.questions.map(normalizeQuestionToInquirer);
      const answers = await inquirer.prompt(qs);
      Object.assign(collectedAnswers, answers);
      continue;
    }

    if (parsed?.mode !== 'actions') {
      throw new Error(`Model returned unknown mode: ${String(parsed?.mode)}`);
    }

    // Apply actions and print summary
    const summary = await applyActions(effectiveRoot, parsed.actions);
    // eslint-disable-next-line no-console
    console.log('\nSummary of this run:');
    if (parsed.summary) console.log(`- ${String(parsed.summary).trim()}`);

    const totalActions =
      summary.writtenFiles.length + summary.downloadedFiles.length + summary.commands.length;
    if (!totalActions) {
      console.log('- No changes were applied (model returned no actions).');
    } else {
      if (summary.writtenFiles.length) {
        console.log(`- ${summary.writtenFiles.length} file(s) written in "${effectiveRoot}":`);
        summary.writtenFiles.forEach((p) => console.log(`  • ${p}`));
      }
      if (summary.downloadedFiles.length) {
        console.log(`- ${summary.downloadedFiles.length} file(s) downloaded into "${effectiveRoot}":`);
        summary.downloadedFiles.forEach((p) => console.log(`  • ${p}`));
      }
      if (summary.commands.length) {
        console.log(`- ${summary.commands.length} command(s) executed:`);
        summary.commands.forEach((c) => console.log(`  • ${c.command} (cwd: ${c.cwd})`));
      }
    }

    console.log('\nWhat you should do next:');
    if (Array.isArray(parsed.next_steps) && parsed.next_steps.length) {
      parsed.next_steps.forEach((s) => console.log(`- ${String(s)}`));
    } else {
      console.log('- If something is missing, run another instruction and describe what you want.');
    }

    if (Array.isArray(parsed.suggested_urls) && parsed.suggested_urls.length) {
      console.log('\nSuggested URLs (verify if needed):');
      parsed.suggested_urls.forEach((u) => console.log(`- ${String(u)}`));
    }

    return { parsed, summary };
  }
}

async function main() {
  program
    .name('codegen')
    .description('Simple OpenAI-powered code generator that can edit files in the current project')
    .option('-p, --prompt <text>', 'Instruction for the code generator (if omitted, you will be asked)')
    .option('-k, --key <string>', 'OpenAI API key (or set OPENAI_API_KEY; if omitted, you will be asked)')
    // If --dir is omitted, you will choose or create a project under the "projects" folder next to this CLI
    .option('-d, --dir <path>', 'Project root directory (if omitted, use managed projects folder)', '')
    .parse(process.argv);

  const opts = program.opts();
  const cliDir = __dirname;
  const managedProjectsRoot = path.join(cliDir, 'projects');

  let apiKey = opts.key || process.env.OPENAI_API_KEY || HARDCODED_OPENAI_API_KEY;
  let prompt = opts.prompt;
  let effectiveRoot = opts.dir ? path.resolve(opts.dir) : '';
  let isNewProject = false;
  let projectName = '';

  // If no explicit --dir, manage projects under ./projects with "new" / "existing" selection
  if (!effectiveRoot) {
    if (!existsSync(managedProjectsRoot)) {
      await mkdir(managedProjectsRoot, { recursive: true });
    }

    // Discover existing projects (subdirectories of managedProjectsRoot)
    const entries = await readdir(managedProjectsRoot, { withFileTypes: true });
    const projects = entries.filter((e) => e.isDirectory()).map((e) => e.name);

    const projectAnswers = await inquirer.prompt([
      {
        type: 'list',
        name: 'mode',
        message: 'Is this a new project or an existing one?',
        choices:
          projects.length > 0
            ? [
                { name: 'Create a new project', value: 'new' },
                { name: 'Use an existing project', value: 'existing' },
              ]
            : [{ name: 'Create a new project', value: 'new' }],
      },
      {
        type: 'input',
        name: 'newName',
        message: 'New project folder name:',
        when: (a) => a.mode === 'new',
        validate: (input) =>
          input && input.trim()
            ? true
            : 'Please enter a project name (e.g. "my-app").',
      },
      {
        type: 'list',
        name: 'existingName',
        message: 'Select an existing project:',
        when: (a) => a.mode === 'existing',
        choices: projects,
      },
    ]);

    projectName =
      projectAnswers.mode === 'new' ? projectAnswers.newName.trim() : projectAnswers.existingName;
    effectiveRoot = path.join(managedProjectsRoot, projectName);

    if (projectAnswers.mode === 'new' && !existsSync(effectiveRoot)) {
      isNewProject = true;
      await mkdir(effectiveRoot, { recursive: true });

      // If this looks like a Stable Diffusion project, scaffold a concrete template up front
      if (projectName.toLowerCase().includes('stable')) {
        const reqPath = path.join(effectiveRoot, 'requirements.txt');
        if (!existsSync(reqPath)) {
          await writeFile(
            reqPath,
            [
              'torch',
              'torchvision',
              'torchaudio',
              'diffusers[torch]',
              'transformers',
              'safetensors',
              'accelerate',
              'xformers',
              'huggingface_hub',
            ].join('\n'),
            'utf8',
          );
        }

        const mainPyPath = path.join(effectiveRoot, 'main.py');
        if (!existsSync(mainPyPath)) {
          await writeFile(
            mainPyPath,
            [
              'import torch',
              'from diffusers import StableDiffusionPipeline',
              '',
              'MODEL_ID = "runwayml/stable-diffusion-v1-5"',
              '',
              'def run_txt2img(prompt: str, output_path: str = "output.png") -> None:',
              '    pipe = StableDiffusionPipeline.from_pretrained(',
              '        MODEL_ID,',
              '        torch_dtype=torch.float16,',
              '    ).to("cuda" if torch.cuda.is_available() else "cpu")',
              '',
              '    image = pipe(prompt).images[0]',
              '    image.save(output_path)',
              '',
              'if __name__ == "__main__":',
              '    user_prompt = input("Enter a prompt for Stable Diffusion: ") or "a photo of an astronaut riding a horse on mars"',
              '    run_txt2img(user_prompt)',
              '    print("Image saved to output.png")',
              '',
            ].join('\n'),
            'utf8',
          );
        }

        const setupBatPath = path.join(effectiveRoot, 'setup.bat');
        if (!existsSync(setupBatPath)) {
          await writeFile(
            setupBatPath,
            [
              '@echo off',
              'setlocal',
              'cd /d "%~dp0"',
              '',
              'echo Creating venv...',
              'python -m venv .venv || goto :error',
              '',
              'echo Activating venv...',
              'call ".venv\\Scripts\\activate.bat" || goto :error',
              '',
              'echo Upgrading pip...',
              'python -m pip install --upgrade pip || goto :error',
              '',
              'echo Installing requirements...',
              'python -m pip install -r requirements.txt || goto :error',
              '',
              'echo.',
              'echo Setup complete.',
              'echo Next: run "run.bat" to generate an image.',
              'echo.',
              'pause',
              'exit /b 0',
              '',
              ':error',
              'echo.',
              'echo Setup failed. Check the error above.',
              'echo If Stable Diffusion model download requires Hugging Face login/terms, you may need to run:',
              'echo   .venv\\Scripts\\huggingface-cli.exe login',
              'echo.',
              'pause',
              'exit /b 1',
              '',
            ].join('\n'),
            'utf8',
          );
        }

        const runBatPath = path.join(effectiveRoot, 'run.bat');
        if (!existsSync(runBatPath)) {
          await writeFile(
            runBatPath,
            [
              '@echo off',
              'setlocal',
              'cd /d "%~dp0"',
              'call ".venv\\Scripts\\activate.bat" || goto :error',
              'python main.py',
              'echo.',
              'pause',
              'exit /b 0',
              ':error',
              'echo Failed to start. Did you run setup.bat first?',
              'pause',
              'exit /b 1',
              '',
            ].join('\n'),
            'utf8',
          );
        }

        const sdReadmePath = path.join(effectiveRoot, 'README.md');
        // Always overwrite README for stable projects so it doesn't contain vague external steps
        await writeFile(
          sdReadmePath,
          [
            `# ${projectName}`,
            '',
            'This project sets up a local Stable Diffusion text-to-image workflow using `diffusers`.',
            '',
            '## One-time setup (Windows)',
            '',
            '1. Ensure you have **Python 3.10+** installed (and on PATH).',
            '2. Double-click:',
            '   - `setup.bat`',
            '',
            'This creates `.venv/` and installs all Python dependencies.',
            '',
            '## Run',
            '',
            '- Double-click: `run.bat`',
            '- Enter a prompt when asked. Output will be saved as `output.png`.',
            '',
            '## Notes / Troubleshooting',
            '',
            '- The first run downloads model weights automatically via Hugging Face.',
            '- Some models require accepting terms or logging into Hugging Face. If you see an auth/terms error, run:',
            '  ```bash',
            '  .venv\\Scripts\\huggingface-cli.exe login',
            '  ```',
            '- If you do not have a compatible GPU, it will run on CPU (slow).',
            '',
          ].join('\n'),
          'utf8',
        );
      } else {
        const readmePath = path.join(effectiveRoot, 'README.md');
        if (!existsSync(readmePath)) {
          await writeFile(
            readmePath,
            `# ${projectName}\n\nScaffolded by the local code generator.\n`,
            'utf8',
          );
        }
      }
    }
  }

  const answers = await inquirer.prompt([
    ...(prompt
      ? []
      : [
          {
            type: 'input',
            name: 'prompt',
            message: 'What do you want the code generator to do?',
            default:
              'Analyze this project and make small, safe improvements to the CLI and tooling.',
          },
        ]),
    ...(apiKey
      ? []
      : [
          {
            type: 'password',
            name: 'apiKey',
            message: 'OpenAI API key (kept local, not saved anywhere):',
            mask: '*',
          },
        ]),
    {
      type: 'confirm',
      name: 'confirm',
      message: () => `Run code generator on "${effectiveRoot}" with your instruction?`,
      default: true,
    },
  ]);

  if (!answers.confirm) {
    // eslint-disable-next-line no-console
    console.log('Cancelled by user.');
    process.exit(0);
  }

  prompt = prompt || answers.prompt;
  apiKey = apiKey || answers.apiKey;
  const referenceUrls = [];

  if (!apiKey) {
    // eslint-disable-next-line no-console
    console.error('OpenAI API key required. Use --key, set OPENAI_API_KEY, or answer the prompt.');
    process.exit(1);
  }

  if (!prompt) {
    // eslint-disable-next-line no-console
    console.error('No instruction provided for the code generator.');
    process.exit(1);
  }

  // Main interaction loop: initial run + optional follow-up prompts
  let currentPrompt = prompt;
  // eslint-disable-next-line no-console
  console.log(`\nUsing project at: ${effectiveRoot}`);

  // First run
  // We also try to auto-repair if an install/run command fails.
  const MAX_AUTO_FIX = 2;
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await runModelDrivenSession({
        effectiveRoot,
        apiKey,
        initialInstruction: currentPrompt,
        isNewProject,
        referenceUrls,
      });
      break;
    } catch (err) {
      attempt += 1;
      // eslint-disable-next-line no-console
      console.error('\nA command failed during this run.');
      // eslint-disable-next-line no-console
      console.error(String(err?.message || err));

      if (attempt > MAX_AUTO_FIX) {
        // eslint-disable-next-line no-console
        console.error(`\nAuto-fix gave up after ${MAX_AUTO_FIX} attempts.`);
        break;
      }

      // Ask the model to fix the project so the failing command can succeed.
      const fixSystemPrompt = `
You are a careful coding assistant fixing a project after a failed command.
You must respond ONLY with JSON:
{
  "summary": "what you fixed",
  "actions": [ { "type": "write_file" | "run_command", ... } ],
  "next_steps": ["..."]
}
Rules:
- Output valid JSON only.
- Make the minimal changes needed to fix the failure.
- Prefer changing package.json dependency versions to real, installable versions.
- If the project should be Python-based, remove unnecessary Node dependencies and add requirements.txt instead.
`;

      const fixPayload = {
        original_instruction: currentPrompt,
        project_root: effectiveRoot,
        error: String(err?.message || err),
        sample_files: await collectFiles(effectiveRoot),
      };

      const rawFix = await callOpenAI({ apiKey, systemPrompt: fixSystemPrompt, payload: fixPayload });
      let parsedFix;
      try {
        parsedFix = JSON.parse(rawFix);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('Auto-fix: failed to parse model JSON. Raw:', rawFix);
        break;
      }

      // eslint-disable-next-line no-console
      console.log('\nAuto-fix attempt:', attempt);
      if (parsedFix.summary) console.log(`- ${String(parsedFix.summary)}`);
      try {
        await applyActions(effectiveRoot, parsedFix.actions);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('Auto-fix actions failed:', e.message);
        break;
      }

      // After applying fix actions, loop again (reruns original prompt which may include run_command steps)
    }
  }

  // Follow-up loop
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const follow = await inquirer.prompt([
      {
        type: 'list',
        name: 'nextAction',
        message: 'What next?',
        choices: [
          { name: 'Run another instruction (same project)', value: 'again' },
          { name: 'Exit (keep window open until you press Enter)', value: 'exit' },
        ],
      },
      {
        type: 'input',
        name: 'nextPrompt',
        message: 'Next instruction:',
        when: (a) => a.nextAction === 'again',
      },
      {
        type: 'input',
        name: 'nextUrls',
        message: 'Any additional reference URLs? (optional)',
        default: '',
        when: (a) => a.nextAction === 'again',
      },
    ]);

    if (follow.nextAction !== 'again') break;
    if (!follow.nextPrompt?.trim()) continue;
    currentPrompt = follow.nextPrompt.trim();
    const nextUrls = parseUrls(follow.nextUrls);
    await runOnce(effectiveRoot, apiKey, currentPrompt, false, nextUrls);
  }

  // eslint-disable-next-line no-console
  console.log('\nAll done.');
  await inquirer.prompt([
    {
      type: 'input',
      name: 'close',
      message: 'Press Enter to close this window (or keep it open to copy logs).',
    },
  ]);
}

if (process.argv[1] === __filename || process.argv[1]?.endsWith('codegen-cli.js')) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}

