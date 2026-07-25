'use client';

import { useState } from 'react';

import { makeT, type Locale } from '../../../lib/i18n';

interface ShopifyTargetFieldsProps {
  apiVersion: string;
  contentType: 'PAGE' | 'BLOG_ARTICLE' | 'PRODUCT';
  operation: 'CREATE' | 'UPDATE';
  handle: string;
  locale: Locale;
  blogId?: string;
  remoteId?: string;
}

export function ShopifyTargetFields(props: ShopifyTargetFieldsProps) {
  const t = makeT(props.locale);
  const [contentType, setContentType] = useState(props.contentType);
  const [operation, setOperation] = useState(props.operation);

  return (
    <>
      <label htmlFor="shopify-api-version">{t('channels.shopifyApiVersionField')}</label>
      <select defaultValue={props.apiVersion} id="shopify-api-version" name="shopifyApiVersion">
        <option value="2026-07">{t('channels.shopifyApiVersionStable')}</option>
      </select>

      <label htmlFor="shopify-content-type">{t('channels.shopifyContentTypeField')}</label>
      <select
        id="shopify-content-type"
        name="shopifyContentType"
        onChange={(event) =>
          setContentType(event.target.value as ShopifyTargetFieldsProps['contentType'])
        }
        value={contentType}
      >
        <option value="PAGE">{t('channels.shopifyContentTypePage')}</option>
        <option value="BLOG_ARTICLE">{t('channels.shopifyContentTypeBlogArticle')}</option>
        <option value="PRODUCT">{t('channels.shopifyContentTypeProduct')}</option>
      </select>

      <label htmlFor="shopify-operation">{t('channels.shopifyOperationField')}</label>
      <select
        id="shopify-operation"
        name="shopifyOperation"
        onChange={(event) =>
          setOperation(event.target.value as ShopifyTargetFieldsProps['operation'])
        }
        value={operation}
      >
        <option value="CREATE">{t('channels.shopifyOperationCreate')}</option>
        <option value="UPDATE">{t('channels.shopifyOperationUpdate')}</option>
      </select>

      <label htmlFor="shopify-handle">{t('channels.shopifyHandleField')}</label>
      <input
        defaultValue={props.handle}
        id="shopify-handle"
        name="shopifyHandle"
        placeholder="approved-answer-guide"
        required
      />

      <label htmlFor="shopify-blog-gid">{t('channels.shopifyBlogGidField')}</label>
      <input
        defaultValue={props.blogId ?? ''}
        disabled={contentType !== 'BLOG_ARTICLE'}
        id="shopify-blog-gid"
        name="shopifyBlogId"
        placeholder="gid://shopify/Blog/123"
        required={contentType === 'BLOG_ARTICLE'}
      />

      <label htmlFor="shopify-remote-gid">{t('channels.shopifyRemoteGidField')}</label>
      <input
        defaultValue={props.remoteId ?? ''}
        disabled={operation !== 'UPDATE'}
        id="shopify-remote-gid"
        name="shopifyRemoteId"
        placeholder="gid://shopify/Page/123"
        required={operation === 'UPDATE'}
      />
    </>
  );
}
