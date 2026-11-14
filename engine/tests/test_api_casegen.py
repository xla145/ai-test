import copy
import json

import pytest
import httpx
import requests

from aitest import api_workspace as ws
from aitest.models import Project
from aitest.store import Store


@pytest.fixture
def parameter_catalog(tmp_path):
    store = Store(tmp_path / 'cases.sqlite')
    project = store.add_project(Project(name='参数生成', workspace_path=str(tmp_path / 'workspace')))
    ws.ensure_schema(store)
    document = {'openapi': '3.0.3', 'info': {'title': 'Orders', 'version': '1'}, 'paths': {'/orders/{productId}': {'post': {
        'summary': '创建订单', 'tags': ['订单'],
        'parameters': [{'in': 'path', 'name': 'productId', 'required': True, 'schema': {'type': 'string'}},
                       {'in': 'query', 'name': 'pageSize', 'required': True, 'schema': {'type': 'integer', 'minimum': 1, 'maximum': 100}}],
        'requestBody': {'required': True, 'content': {'application/json': {'schema': {
            'type': 'object', 'required': ['quantity', 'profile'], 'additionalProperties': False,
            'properties': {'quantity': {'type': 'integer', 'minimum': 1, 'maximum': 5},
                           'status': {'type': 'string', 'enum': ['enabled', 'disabled']},
                           'profile': {'type': 'object', 'required': ['name'], 'properties': {'name': {'type': 'string', 'pattern': '^[A-Z]{2,4}$', 'minLength': 2, 'maxLength': 4}}}}
        }}}}, 'responses': {'200': {'description': 'OK'}, '400': {'description': 'Bad input'}}
    }}}}
    definition = ws.import_document(store, project.id, {'source': 'orders.yaml', 'document': document})['definitions'][0]
    request = copy.deepcopy(definition['request'])
    request.update(path_params={'productId': 'REAL-SKU'}, query={'pageSize': 10},
                   body={'quantity': 2, 'status': 'enabled', 'profile': {'name': 'AB'}}, auth=True, role='运营', encrypt=True,
                   headers={'Authorization': 'Bearer must-not-persist', 'X-Trace': 'custom'}, extract={'orderId': 'data.id'})
    draft = {'title': '订单-创建', 'kind': 'single', 'steps': [request], 'inputs': {'shared': 7}}
    options = {'max_cases': 50, 'seed': 42, 'include_negative': True, 'response_mode': 'http'}
    yield store, project, definition, draft, options
    store.close()


def test_preview_is_offline_reproducible_and_covers_nested_constraints(parameter_catalog, monkeypatch):
    store, p, d, draft, options = parameter_catalog
    def no_network(*args, **kwargs):
        raise AssertionError('generation must not send requests')
    monkeypatch.setattr(httpx.Client, 'request', no_network)
    monkeypatch.setattr(requests.Session, 'request', no_network)
    first = ws.preview_parameter_cases(store, p.id, draft, options)
    from aitest.api_casegen import _framework_values
    _framework_values.cache_clear()
    second = ws.preview_parameter_cases(store, p.id, draft, options)
    assert first == second
    assert store.list_cases(p.id) == []
    assert first['engine'].startswith('Schemathesis')
    assert 1 < len(first['candidates']) <= 50
    assert len({c['key'] for c in first['candidates']}) == len(first['candidates'])
    labels = [c['scenario'] for c in first['candidates']]
    assert any('body.profile.name 缺少必填' in label for label in labels)
    assert any('pageSize 最小值' in label for label in labels)
    assert any('非法枚举' in label for label in labels)
    assert any('Schema' in label for label in labels)
    assert 'must-not-persist' not in json.dumps(first)
    for item in first['candidates']:
        request = item['request']
        assert request['auth'] is True and request['role'] == '运营' and request['encrypt'] is True
        assert 'extract' not in request and request['headers'].get('X-Trace') == 'custom'
        if 'path_params.productId' not in item['scenario']:
            assert request['path_params']['productId'] == 'REAL-SKU'
        if item['polarity'] == 'negative':
            assert request['expected_status'] == [400]
            assert request['response_schema'] is None


def test_business_codes_and_positive_only_generation(parameter_catalog):
    store, p, d, draft, options = parameter_catalog
    options.update(response_mode='business', code_path='code', success_code=200, error_code=500)
    result = ws.preview_parameter_cases(store, p.id, draft, options)
    for c in result['candidates']:
        assert c['request']['expected_status'] == [200]
        assert c['request']['expected_fields']['code'] == (200 if c['polarity'] == 'positive' else 500)
    del options['error_code']
    with pytest.raises(ValueError, match='业务码'):
        ws.preview_parameter_cases(store, p.id, draft, options)
    options['include_negative'] = False
    result = ws.preview_parameter_cases(store, p.id, draft, options)
    assert all(c['polarity'] == 'positive' for c in result['candidates'])


def test_selection_save_dedup_and_contract_revision(parameter_catalog):
    store, p, d, draft, options = parameter_catalog
    preview = ws.preview_parameter_cases(store, p.id, draft, options)
    selected = [c['key'] for c in preview['candidates'][:2]]
    saved = ws.save_parameter_cases(store, p.id, draft, options, selected)
    assert saved['generated'] == 2 and saved['skipped'] == 0
    case = store.get_case(selected[0])
    assert case.status == 'draft' and case.api_inputs == draft['inputs']
    case.title = '人工修改-保留'
    case.status = 'reviewed'
    store.upsert_case(case)
    again = ws.save_parameter_cases(store, p.id, draft, options, selected)
    assert again['generated'] == 0 and again['skipped'] == 2
    assert store.get_case(case.id).title == '人工修改-保留'
    assert store.get_case(case.id).status == 'reviewed'
    with pytest.raises(ValueError, match='预览已变化'):
        ws.save_parameter_cases(store, p.id, draft, options, ['forged'])
    draft['steps'][0]['definition_revision'] = 0
    with pytest.raises(ValueError, match='已更新'):
        ws.preview_parameter_cases(store, p.id, draft, options)


@pytest.mark.parametrize('value', [0, 101, True, '30'])
def test_generation_limit_is_validated(parameter_catalog, value):
    store, p, d, draft, options = parameter_catalog
    options['max_cases'] = value
    with pytest.raises(ValueError, match='数量'):
        ws.preview_parameter_cases(store, p.id, draft, options)


def test_external_references_are_not_fetched(parameter_catalog):
    from aitest import api_casegen, openapi
    store, p, d, draft, options = parameter_catalog
    operation = openapi.Operation(method='POST', path=d['path'], operation_id='create', summary='', body_schema={'$ref': 'https://external.invalid/schema'})
    with pytest.raises(ValueError, match='外部'):
        api_casegen.generate(d, operation, draft, options)


def test_transport_coercion_does_not_create_false_negative_cases(parameter_catalog):
    from aitest.api_casegen import _transport_valid
    assert _transport_valid(12345, {'type': 'string'}, 'path_params')
    assert _transport_valid('12', {'type': 'integer', 'minimum': 1}, 'query')
    assert not _transport_valid('not-a-number', {'type': 'integer'}, 'query')
    assert not _transport_valid(12345, {'type': 'string'}, 'body')
    store, p, d, draft, options = parameter_catalog
    result = ws.preview_parameter_cases(store, p.id, draft, options)
    assert not any(c['polarity'] == 'negative' and c['scenario'] == 'path_params.productId 类型错误' for c in result['candidates'])


def test_schema_normalization_does_not_change_property_names_or_examples():
    from aitest.api_casegen import _json_schema
    schema = {'type': 'object', 'properties': {'nullable': {'type': 'boolean'}, 'type': {'type': 'string', 'nullable': True}},
              'example': {'nullable': True, 'type': 'string'}}
    normalized = _json_schema(schema)
    assert normalized['properties']['nullable'] == {'type': 'boolean'}
    assert normalized['properties']['type']['type'] == ['string', 'null']
    assert normalized['example'] == schema['example']
