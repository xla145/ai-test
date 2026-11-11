#!/usr/bin/env python3
"""Read-only Maven discovery for the current backend; no builds or config secrets."""
import argparse
import json
import os
from pathlib import Path
import xml.etree.ElementTree as ET

SKIP = {'.git', '.idea', 'target', 'node_modules', '.venv', 'legacy', 'archive', 'archives'}
NS = {'m': 'http://maven.apache.org/POM/4.0.0'}
PUBLIC = {'R.java', 'TableDataInfo.java', 'PageQuery.java', 'BaseMapperPlus.java',
          'BaseEntity.java', 'TenantEntity.java', 'LoginHelper.java', 'ServiceException.java',
          'MapstructUtils.java', 'InjectionMetaObjectHandler.java', 'JacksonConfig.java',
          'PlusTenantLineHandler.java'}


def resolve_root(root):
    if (root / 'pom.xml').is_file():
        return root
    candidates = sorted(p.parent for p in root.glob('*/pom.xml')
                        if not p.parent.is_symlink() and p.parent.name not in SKIP)
    if len(candidates) == 1:
        return candidates[0].resolve()
    raise ValueError('请指定含 pom.xml 的后端根目录；候选：' + ', '.join(map(str, candidates)))


def inspect(requested):
    root = resolve_root(requested)
    warnings = []
    modules = []
    seen = set()

    def inside(path):
        return path.is_relative_to(root)

    def parse_pom(pom):
        pom = pom.resolve()
        if not inside(pom):
            warnings.append('跳过工程外 POM: ' + str(pom))
            return
        if pom in seen:
            return
        seen.add(pom)
        if not pom.is_file():
            warnings.append('缺少 POM: ' + str(pom.relative_to(root)))
            return
        tree = ET.parse(pom)

        def value(path):
            e = tree.find(path, NS)
            return e.text.strip() if e is not None and e.text else None

        def children(path):
            return [e.text.strip() for e in tree.findall(path, NS) if e.text]

        record = {
            'path': str(pom.parent.relative_to(root)),
            'coordinates': {k: value('m:' + k) for k in ('groupId', 'artifactId', 'version')},
            'parent': {k: value('m:parent/m:' + k) for k in ('groupId', 'artifactId', 'version')},
            'packaging': value('m:packaging') or 'jar',
            'modules': children('m:modules/m:module'),
            'dependencies': children('m:dependencies/m:dependency/m:artifactId'),
            'profiles': children('m:profiles/m:profile/m:id'),
        }
        if pom == root / 'pom.xml':
            record['properties'] = {key: value('m:properties/m:' + key) for key in
                                    ('java.version', 'spring-boot.version', 'mybatis-plus.version',
                                     'revision', 'skipTests', 'profiles.active')}
            record['surefire_groups'] = value(
                "m:build/m:plugins/m:plugin[m:artifactId='maven-surefire-plugin']/m:configuration/m:groups")
        modules.append(record)
        for module in record['modules']:
            if '${' in module:
                warnings.append('未展开模块表达式: ' + module)
            else:
                parse_pom(pom.parent / module / 'pom.xml')

    parse_pom(root / 'pom.xml')
    public = []
    docs = []
    entrypoints = []
    configs = []
    directories = {key: set() for key in ('bo', 'vo', 'mapper_xml', 'migrations', 'tests')}
    examples = []
    for directory, subdirs, files in os.walk(root, followlinks=False):
        subdirs[:] = sorted(d for d in subdirs if d not in SKIP and not (Path(directory) / d).is_symlink())
        for name in sorted(files):
            path = Path(directory) / name
            if path.is_symlink():
                continue
            rel = path.relative_to(root).as_posix()
            if name in PUBLIC or name.endswith('ExceptionHandler.java'):
                public.append(rel)
            if name in {'AGENTS.md', 'CLAUDE.md', 'java-code-standards.md'} and 'workspace-seed/' not in rel:
                docs.append(rel)
            if name.endswith('Application.java') and '/src/main/java/' in rel:
                entrypoints.append(rel)
            if name == 'FlywayConfig.java' or (name.startswith('application') and name.endswith(('.yml', '.yaml'))):
                configs.append(rel)
            for kind in ('bo', 'vo'):
                if '/src/main/java/' in rel and '/domain/' + kind + '/' in rel:
                    directories[kind].add(rel.split('/domain/' + kind + '/')[0] + '/domain/' + kind)
            if '/src/main/resources/mapper/' in rel and name.endswith('.xml'):
                directories['mapper_xml'].add(str(path.parent.relative_to(root)))
            if ('/flyway/' in rel or '/db/migration/' in rel) and name.endswith('.sql'):
                directories['migrations'].add(str(path.parent.relative_to(root)))
            if '/src/test/' in rel:
                directories['tests'].add(rel.split('/src/test/')[0] + '/src/test')
            if name == 'HelpDocController.java' or (name.endswith('Controller.java') and len(examples) < 8):
                examples.append(rel)
    return {
        'root': str(root), 'modules': modules, 'guidance_files': sorted(docs),
        'public_classes': sorted(public), 'entrypoint_candidates': sorted(entrypoints),
        'configuration_paths': sorted(configs),
        'source_directories': {k: sorted(v) for k, v in directories.items()},
        'controller_candidates': sorted(examples), 'warnings': warnings,
        'limitations': '仅读取静态 POM 和文件路径，不读取配置密钥；不展开继承/属性/profile 模块，不验证有效依赖、扫描、权限、租户或构建。候选 Controller 不是架构标准。'
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True, type=Path)
    args = parser.parse_args()
    try:
        result = inspect(args.root.expanduser().resolve())
    except (ValueError, OSError, ET.ParseError) as exc:
        parser.exit(2, f'探测失败：{exc}\n')
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
