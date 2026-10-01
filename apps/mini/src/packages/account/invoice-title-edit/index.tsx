import { useState } from 'react';
import { Text, View } from '@tarojs/components';
import { useRouteMutation, useRouteQuery } from '@shop/api-client/react';
import { chooseInvoiceTitle, goBack, useRouteParams } from '@/platform';
import { LoginGate } from '@/session/login-card';
import { useSignedIn } from '@/session/session';
import { Button } from '@/ui/button';
import { Cell, CellGroup } from '@/ui/cell';
import { Radio, Switch } from '@/ui/choice';
import { ErrorBlock } from '@/ui/error-block';
import { toast } from '@/ui/feedback';
import { Field } from '@/ui/field';
import { Icon } from '@/ui/icon';
import { PageShell } from '@/ui/page-shell';
import { CellSkeleton } from '@/ui/skeleton';
import { SubmitBar, errorMessage, fieldErrorsOf, firstError } from '../shared/form';
import {
  EMPTY_INVOICE_DRAFT,
  INVOICE_FIELDS,
  INVOICE_TITLE_READS as INVALIDATE,
  checkInvoiceDraft,
  draftFromChosen,
  draftFromTitle,
  effectiveInvoiceType,
  invoiceTitleBody,
  useCreatedInvoiceTitle,
  type InvoiceDraft,
  type InvoiceErrors,
  type InvoiceField,
} from '../shared/invoice';
import './index.scss';

/**
 * 新增 / 编辑发票抬头 (`invoiceTitleEdit { id? }`, pages.md §2.6). Titles are kept on the
 * server; 从微信导入 (`chooseInvoiceTitle`, C04) fills the form; the name passes WeChat's
 * content check (C09), and a rejected one is an error on the name field.
 */
export default function InvoiceTitleEditPage() {
  const { id } = useRouteParams('invoiceTitleEdit');
  return (
    <PageShell title={id ? '编辑发票抬头' : '新增发票抬头'} withBar>
      <LoginGate
        reason="登录后可以管理发票抬头"
        redirect={{ route: 'invoiceTitleEdit', params: id ? { id } : {} }}
      >
        {id ? <ExistingTitle id={id} /> : <TitleForm initial={EMPTY_INVOICE_DRAFT} />}
      </LoginGate>
    </PageShell>
  );
}

function ExistingTitle({ id }: { id: string }) {
  const signedIn = useSignedIn();
  const title = useRouteQuery('user.invoiceTitleDetail', { params: { id } }, { enabled: signedIn });
  if (title.isPending) return <CellSkeleton rows={5} />;
  if (title.isError) return <ErrorBlock error={title.error} onRetry={() => title.refetch()} />;
  return <TitleForm id={id} initial={draftFromTitle(title.data)} />;
}

function TitleForm({ id, initial }: { id?: string; initial: InvoiceDraft }) {
  const [draft, setDraft] = useState(initial);
  // The server keeps an edited default the default: its switch cannot be turned off here.
  const keepsDefault = id !== undefined && initial.isDefault;
  const [errors, setErrors] = useState<InvoiceErrors>({});
  const [focus, setFocus] = useState<InvoiceField | null>(null);
  const create = useRouteMutation('user.invoiceTitleCreate', { invalidate: INVALIDATE });
  const update = useRouteMutation('user.invoiceTitleUpdate', { invalidate: INVALIDATE });
  const company = draft.headerType === 'company';
  const special = effectiveInvoiceType(draft) === 'special';

  const change = <K extends keyof InvoiceDraft>(key: K, value: InvoiceDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    if ((INVOICE_FIELDS as readonly string[]).includes(key)) {
      setErrors((current) => ({ ...current, [key]: undefined }));
    }
  };

  async function importWechat() {
    const chosen = await chooseInvoiceTitle().catch(() => null);
    if (!chosen) return;
    setDraft((current) => draftFromChosen(current, chosen));
    setErrors({});
  }

  async function submit() {
    const found = checkInvoiceDraft(draft);
    const first = firstError(found, INVOICE_FIELDS);
    setErrors(found);
    if (first) {
      setFocus(first);
      toast.text(found[first] ?? '请检查填写的内容');
      return;
    }
    const body = invoiceTitleBody(draft);
    try {
      if (id) {
        await update.mutateAsync({ params: { id }, body });
      } else {
        const created = await create.mutateAsync({ body });
        useCreatedInvoiceTitle.setState({ id: created.id });
      }
    } catch (error) {
      const fields = fieldErrorsOf(error, { USER_INVOICE_TITLE_REJECTED: 'name' });
      if (fields) {
        const next: InvoiceErrors = {};
        for (const field of INVOICE_FIELDS) next[field] = fields[field];
        setErrors(next);
        const at = firstError(next, INVOICE_FIELDS);
        setFocus(at);
        toast.text((at && next[at]) ?? errorMessage(error));
      } else {
        toast.text(errorMessage(error));
      }
      return;
    }
    toast.success('已保存');
    void goBack();
  }

  const field = (
    key: InvoiceField,
    label: string,
    placeholder: string,
    extra: { maxLength?: number; type?: 'tel' | 'text' } = {},
  ) => (
    <Field
      label={label}
      placeholder={placeholder}
      value={draft[key]}
      maxLength={extra.maxLength}
      type={extra.type}
      error={errors[key]}
      focus={focus === key}
      // Cleared on blur: a second failed save on the same field must change it to focus again.
      onBlur={() => setFocus(null)}
      onChange={(value) => change(key, value)}
    />
  );

  return (
    <View className="account-page">
      <CellGroup>
        <Cell
          title={
            <View className="invoice-edit__import">
              <Icon name="download" />
              <Text>从微信导入</Text>
            </View>
          }
          label="从微信导入"
          onClick={() => importWechat()}
        />
      </CellGroup>
      <CellGroup>
        <Cell
          title="抬头类型"
          value={
            <View className="invoice-edit__choices">
              <Radio
                label="企业"
                checked={company}
                onChange={() => change('headerType', 'company')}
              />
              <Radio
                label="个人"
                checked={!company}
                onChange={() => change('headerType', 'personal')}
              />
            </View>
          }
        />
        {company ? (
          <Cell
            title="发票类型"
            value={
              <View className="invoice-edit__choices">
                <Radio
                  label="普通发票"
                  checked={!special}
                  onChange={() => change('invoiceType', 'plain')}
                />
                <Radio
                  label="专用发票"
                  checked={special}
                  onChange={() => change('invoiceType', 'special')}
                />
              </View>
            }
          />
        ) : null}
        {field('name', company ? '单位名称' : '抬头名称', company ? '单位全称' : '个人或姓名', {
          maxLength: 100,
        })}
        {company ? field('dutyNumber', '税号', '纳税人识别号', { maxLength: 50 }) : null}
      </CellGroup>
      {special ? (
        <CellGroup title="专用发票信息">
          {field('registeredAddress', '注册地址', '单位注册地址', { maxLength: 255 })}
          {field('registeredTel', '注册电话', '单位注册电话', { maxLength: 30 })}
          {field('bankName', '开户银行', '开户银行名称', { maxLength: 100 })}
          {field('bankAccount', '银行账号', '开户银行账号', { maxLength: 50 })}
        </CellGroup>
      ) : null}
      <CellGroup title="收票信息（选填）">
        {field('drawerPhone', '手机号', '接收开票通知', { type: 'tel' })}
        {field('email', '邮箱', '接收电子发票', { maxLength: 100 })}
      </CellGroup>
      <CellGroup>
        <Cell
          title="设为默认抬头"
          description={keepsDefault ? '这是默认抬头；要换默认，请把其他抬头设为默认' : undefined}
          value={
            <Switch
              label="设为默认抬头"
              checked={keepsDefault || draft.isDefault}
              disabled={keepsDefault}
              onChange={(checked) => change('isDefault', checked)}
            />
          }
        />
      </CellGroup>
      <SubmitBar>
        <Button size="lg" block loading={create.isPending || update.isPending} onClick={submit}>
          保存
        </Button>
      </SubmitBar>
    </View>
  );
}
