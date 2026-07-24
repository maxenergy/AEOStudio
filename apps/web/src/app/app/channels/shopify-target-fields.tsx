'use client';

import { useState } from 'react';

interface ShopifyTargetFieldsProps {
  apiVersion: string;
  contentType: 'PAGE' | 'BLOG_ARTICLE' | 'PRODUCT';
  operation: 'CREATE' | 'UPDATE';
  handle: string;
  blogId?: string;
  remoteId?: string;
}

export function ShopifyTargetFields(props: ShopifyTargetFieldsProps) {
  const [contentType, setContentType] = useState(props.contentType);
  const [operation, setOperation] = useState(props.operation);

  return (
    <>
      <label htmlFor="shopify-api-version">Shopify Admin API version</label>
      <select defaultValue={props.apiVersion} id="shopify-api-version" name="shopifyApiVersion">
        <option value="2026-07">2026-07 (stable)</option>
      </select>

      <label htmlFor="shopify-content-type">Shopify content type</label>
      <select
        id="shopify-content-type"
        name="shopifyContentType"
        onChange={(event) =>
          setContentType(event.target.value as ShopifyTargetFieldsProps['contentType'])
        }
        value={contentType}
      >
        <option value="PAGE">Page</option>
        <option value="BLOG_ARTICLE">Blog article</option>
        <option value="PRODUCT">Product</option>
      </select>

      <label htmlFor="shopify-operation">Shopify draft operation</label>
      <select
        id="shopify-operation"
        name="shopifyOperation"
        onChange={(event) =>
          setOperation(event.target.value as ShopifyTargetFieldsProps['operation'])
        }
        value={operation}
      >
        <option value="CREATE">Create new unpublished content</option>
        <option value="UPDATE">Update owned unpublished content</option>
      </select>

      <label htmlFor="shopify-handle">Shopify handle</label>
      <input
        defaultValue={props.handle}
        id="shopify-handle"
        name="shopifyHandle"
        placeholder="approved-answer-guide"
        required
      />

      <label htmlFor="shopify-blog-gid">Shopify blog GID</label>
      <input
        defaultValue={props.blogId ?? ''}
        disabled={contentType !== 'BLOG_ARTICLE'}
        id="shopify-blog-gid"
        name="shopifyBlogId"
        placeholder="gid://shopify/Blog/123"
        required={contentType === 'BLOG_ARTICLE'}
      />

      <label htmlFor="shopify-remote-gid">Shopify remote GID</label>
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
