import { Text, View } from '@tarojs/components';
import { Checkbox, Radio } from '@/ui/choice';
import { Field, Textarea } from '@/ui/field';
import { fillable, type CustomAnswers, type CustomFormField } from './checkout-view';
import './custom-form.scss';

export interface CustomFormProps {
  fields: readonly CustomFormField[];
  answers: CustomAnswers;
  onChange: (key: string, answer: string | readonly string[]) => void;
}

/**
 * 商品的自定义表单 (`customFormFields`), filled in at checkout: one row per field, by type.
 * An 图片 field cannot be filled in yet (no upload purpose for it); it says so instead.
 */
export function CustomForm({ fields, answers, onChange }: CustomFormProps) {
  return (
    <View className="custom-form" id="checkout-custom-form">
      {fields.map((field) => {
        const answer = answers[field.key];
        const text = typeof answer === 'string' ? answer : '';
        const picked = Array.isArray(answer) ? (answer as readonly string[]) : [];
        const title = (
          <Text className="custom-form__label">
            {field.required ? (
              <Text className="custom-form__required" ariaHidden>
                *
              </Text>
            ) : null}
            {field.label}
          </Text>
        );
        if (!fillable(field)) {
          return (
            <View key={field.key} className="custom-form__row">
              {title}
              <Text className="custom-form__note">图片暂不支持在小程序内上传，请联系客服提供</Text>
            </View>
          );
        }
        if (field.type === 'textarea') {
          return (
            <View key={field.key} className="custom-form__row">
              {title}
              <Textarea
                label={field.label}
                value={text}
                placeholder={field.placeholder}
                onChange={(value) => onChange(field.key, value)}
              />
            </View>
          );
        }
        if (field.type === 'radio' || field.type === 'select') {
          return (
            <View key={field.key} className="custom-form__row">
              {title}
              <View className="custom-form__options" ariaRole="radiogroup" ariaLabel={field.label}>
                {(field.options ?? []).map((option) => (
                  <Radio
                    key={option}
                    label={option}
                    checked={text === option}
                    onChange={() => onChange(field.key, option)}
                  />
                ))}
              </View>
            </View>
          );
        }
        if (field.type === 'checkbox') {
          return (
            <View key={field.key} className="custom-form__row">
              {title}
              <View className="custom-form__options" ariaRole="group" ariaLabel={field.label}>
                {(field.options ?? []).map((option) => (
                  <Checkbox
                    key={option}
                    label={option}
                    checked={picked.includes(option)}
                    onChange={(on) =>
                      onChange(
                        field.key,
                        on ? [...picked, option] : picked.filter((value) => value !== option),
                      )
                    }
                  />
                ))}
              </View>
            </View>
          );
        }
        return (
          <Field
            key={field.key}
            label={field.label}
            required={field.required}
            type={field.type === 'number' ? 'digit' : 'text'}
            placeholder={
              field.placeholder ?? (field.type === 'date' ? '例如 2026-10-01' : '请填写')
            }
            value={text}
            onChange={(value) => onChange(field.key, value)}
          />
        );
      })}
    </View>
  );
}
