import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import typescript from '@rollup/plugin-typescript';
import { languageConfiguration, textMateGrammar } from '@coderline/alphatab-language-server';
import type { OutputOptions, OutputPlugin } from 'rollup';
import license from 'rollup-plugin-license';
import { type MinifyOptions, minify } from 'terser';
import {
    defaultClientMainFields,
    defineConfig,
    type LibraryOptions,
    type UserConfig
} from 'vite';

const require = createRequire(import.meta.url);
const projectDir = import.meta.dirname;
const bravuraWoff2Path = require.resolve('@coderline/alphatab/font/Bravura.woff2');
const sonivoxSf3Path = require.resolve('@coderline/alphatab/soundfont/sonivox.sf3');

const terserOptions: MinifyOptions = {
    mangle: {
        properties: {
            regex: /^_/
        }
    }
};

function getGitBranch(): string {
    const headPath = path.resolve(projectDir, '.git/HEAD');
    if (!fs.existsSync(headPath)) {
        return '';
    }
    const buf = fs.readFileSync(headPath, 'utf8');
    const match = /ref: refs\/heads\/([^\n]+)/.exec(buf);
    return match ? match[1] : '';
}

function licenseHeaderPlugin() {
    return license({
        banner: {
            commentStyle: 'ignored',
            content: { file: path.resolve(projectDir, 'LICENSE.header') },
            data() {
                return {
                    branch: getGitBranch(),
                    build: process.env.GITHUB_RUN_NUMBER || 0
                };
            }
        }
    });
}

function terserMinPlugin(): OutputPlugin {
    return {
        name: 'min',
        async writeBundle(opts, bundle) {
            for (const file of Object.keys(bundle)) {
                const chunk = bundle[file];
                if ((file.endsWith('.mjs') || file.endsWith('.js')) && chunk.type === 'chunk' && chunk.isEntry) {
                    const o = { ...terserOptions };
                    if (opts.format === 'es') {
                        o.module = true;
                    } else if (opts.format === 'cjs') {
                        o.toplevel = true;
                    }
                    const result = await minify(chunk.code, o);
                    const outputFile = path.resolve(
                        opts.dir!,
                        file.replace('.mjs', '.min.mjs').replace('.js', '.min.js')
                    );
                    await fs.promises.writeFile(outputFile, result.code!);
                }
            }
        }
    };
}

function baseConfig(): UserConfig {
    return {
        esbuild: false,
        plugins: [licenseHeaderPlugin()],
        build: {
            emptyOutDir: false,
            lib: { entry: {} },
            minify: false,
            rollupOptions: {
                external: [/^vscode/, /node:\w+/],
                output: [],
                onLog(level, log, handler) {
                    if (log.code === 'CIRCULAR_DEPENDENCY' || log.code === 'EMPTY_BUNDLE') {
                        return;
                    }
                    handler(level, log);
                }
            }
        }
    };
}

export default defineConfig(({ mode }) => {
    const config = baseConfig();
    config.build!.sourcemap = true;
    config.resolve ??= {};
    config.resolve.mainFields = defaultClientMainFields.filter(f => f !== 'browser');
    config.resolve.mainFields.unshift('require');

    if (mode === 'previewApp') {
        // Preview app: UMD bundle that runs in the webview, bundles alphaTab in.
        config.plugins!.unshift(typescript({ tsconfig: './tsconfig.json', module: 'preserve', include: ['**/*.ts'] }));

        const lib = config.build!.lib! as LibraryOptions;
        lib.entry = { preview: path.resolve(projectDir, 'src/preview/app/index.ts') };

        config.plugins!.push({
            name: 'import-meta',
            resolveImportMeta() {
                return '{}';
            }
        });

        (config.build!.rollupOptions!.output as OutputOptions[]).push({
            dir: 'dist/',
            format: 'umd',
            name: 'preview',
            entryFileNames: '[name].js',
            chunkFileNames: '[name].js',
            plugins: [terserMinPlugin()]
        });

        config.plugins!.push({
            name: 'copy-alphatab-assets',
            apply: 'build',
            async writeBundle() {
                const outDir = path.join(projectDir, 'dist', 'assets');
                await fs.promises.mkdir(outDir, { recursive: true });
                await fs.promises.copyFile(sonivoxSf3Path, path.join(outDir, 'sonivox.sf3'));
                await fs.promises.copyFile(bravuraWoff2Path, path.join(outDir, 'Bravura.woff2'));
            }
        });

        config.plugins!.push({
            name: 'app-html',
            apply: 'build',
            async writeBundle() {
                await fs.promises.copyFile(
                    path.join(projectDir, 'src/preview/app/index.html'),
                    path.join(projectDir, 'dist/preview.html')
                );
            }
        });

        return config;
    }

    // Extension host: CommonJS, vscode left external.
    config.plugins!.unshift(typescript({ tsconfig: './tsconfig.json', module: 'preserve', include: ['**/*.ts'] }));

    const lib = config.build!.lib! as LibraryOptions;
    lib.entry = {
        extension: path.resolve(projectDir, 'src/extension.ts'),
        server: path.resolve(projectDir, 'src/server.ts')
    };

    (config.build!.rollupOptions!.output as OutputOptions[]).push({
        dir: 'dist/',
        format: 'cjs',
        entryFileNames: '[name].js'
    });

    config.plugins!.push({
        name: 'language-files',
        apply: 'build',
        async buildStart() {
            await fs.promises.writeFile(
                path.join(projectDir, 'language-configuration.json'),
                JSON.stringify(languageConfiguration, null, 2)
            );
            await fs.promises.mkdir(path.join(projectDir, 'syntaxes'), { recursive: true });
            await fs.promises.writeFile(
                path.join(projectDir, 'syntaxes/alphatex.tmLanguage.json'),
                JSON.stringify(textMateGrammar, null, 2)
            );
        }
    });

    return config;
});
